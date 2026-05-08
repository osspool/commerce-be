/**
 * Posting Service — Revenue → Ledger Bridge
 *
 * Converts commerce events (POS sales, orders, purchases, refunds)
 * into double-entry journal entries using @classytic/ledger's
 * PostingContract pattern.
 *
 * Design:
 *   - Each contract maps a source event to journal entry items
 *   - Account codes resolved to ObjectIds globally (company-wide accounts)
 *   - Idempotency keys prevent duplicate postings on retry
 *   - All amounts are in paisa (integer cents) — matches both revenue and ledger
 *   - Journal entries tagged with organizationId (branch) via extraFields
 */

import type mongoose from 'mongoose';
import logger from '#lib/utils/logger.js';
import { Account, accountRepository, JournalEntry, journalEntryRepository } from '../accounting.engine.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PostingItem {
  accountCode: string;
  debit: number; // paisa (integer) — always in base currency (BDT)
  credit: number; // paisa (integer) — always in base currency (BDT)
  label?: string;
  /** Subsidiary-ledger partner tag — Supplier._id or Customer._id stringified */
  partnerId?: string;
  /** 'supplier' | 'customer' — disambiguates a single partnerId across books */
  partnerType?: 'supplier' | 'customer';
  /** Due date used by generateAgedBalance to bucket AR/AP lines */
  maturityDate?: Date;
  /** Foreign currency ISO 4217 code (audit trail). Omit when transaction is in BDT. */
  foreignCurrency?: string;
  /** Original debit in foreign currency minor units (audit trail). */
  foreignDebit?: number;
  /** Original credit in foreign currency minor units (audit trail). */
  foreignCredit?: number;
  /** Exchange rate: foreignCurrency → BDT at posting time. */
  exchangeRate?: number;
}

export interface PostingInput {
  journalType: string;
  label: string;
  date: Date;
  items: PostingItem[];
  idempotencyKey: string;
  sourceRef?: { sourceModel: string; sourceId: string };
  autoPost?: boolean;
  /**
   * Actor for the post() call. Required when ledger strictness.requireActor
   * is on (which it is in this engine). For background flows with no user
   * context (auto-close hook, scheduled jobs) we fall back to SYSTEM_ACTOR_ID.
   */
  actorId?: string;
  /**
   * Free-form metadata stamped on the journal entry (`entryData.metadata`).
   * Used today by the COGS pipeline to flag entries that posted with no cost
   * basis (`costMissing: true` + `affectedLines`) so the admin "cost data
   * gaps" view can surface them. Schema-less by design — different posting
   * sources tag whatever provenance they need.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Sentinel ObjectId used when an internal background operation needs to post
 * a journal entry without a real user. The audit log will show this id and
 * an operator can grep for it.
 */
export const SYSTEM_ACTOR_ID = '000000000000000000000001';

// ─── Account Code → ObjectId Cache (company-wide) ──────────────────────────

const accountCache = new Map<string, mongoose.Types.ObjectId>();

export async function resolveAccountId(accountCode: string): Promise<mongoose.Types.ObjectId> {
  const cached = accountCache.get(accountCode);
  if (cached) return cached;

  const account = await Account.findOne({
    accountTypeCode: accountCode,
    active: true,
  })
    .select('_id')
    .lean();

  if (!account) {
    throw new Error(`Account '${accountCode}' not found. Run /accounting/accounts/seed first.`);
  }

  const id = account._id as mongoose.Types.ObjectId;
  accountCache.set(accountCode, id);
  return id;
}

/** Clear cache (e.g., after seeding). */
export function clearAccountCache(): void {
  accountCache.clear();
}

// ─── Core Posting Function ──────────────────────────────────────────────────

/**
 * Create a journal entry from a posting input.
 * Resolves account codes to ObjectIds, creates as draft, optionally posts.
 *
 * Idempotency: @classytic/ledger >=0.8.1 wraps `journalEntries.create` with a
 * race-safe implementation — pre-checks by `idempotencyKey`, catches
 * dup-key / IdempotencyConflictError, and returns the winner. We just pass
 * `idempotencyKey` through; no in-host recovery needed.
 *
 * @param branchId — branch that originated this entry (optional tag)
 * @param input — posting data
 */
export async function createPosting(
  branchId: string | undefined,
  input: PostingInput,
): Promise<{ journalEntryId: string; state: string }> {
  // Resolve account codes to ObjectIds (company-wide)
  const journalItems = await Promise.all(
    input.items.map(async (item) => ({
      account: await resolveAccountId(item.accountCode),
      debit: item.debit,
      credit: item.credit,
      label: item.label,
      date: input.date,
      ...(item.partnerId ? { partnerId: item.partnerId } : {}),
      ...(item.partnerType ? { partnerType: item.partnerType } : {}),
      ...(item.maturityDate ? { maturityDate: item.maturityDate } : {}),
      // Multi-currency audit trail (ledger 0.9.1) — GL stays in BDT,
      // foreign currency is metadata for audit + FX realization
      ...(item.foreignCurrency
        ? {
            currency: item.foreignCurrency,
            exchangeRate: item.exchangeRate,
            originalDebit: item.foreignDebit ?? null,
            originalCredit: item.foreignCredit ?? null,
          }
        : {}),
    })),
  );

  // Create draft journal entry with optional branch tag. The ledger's
  // race-safe wrapper guarantees at-most-one entry per idempotencyKey
  // (per org) across concurrent callers.
  const entryData: Record<string, unknown> = {
    journalType: input.journalType,
    label: input.label,
    date: input.date,
    journalItems,
    state: 'draft',
    idempotencyKey: input.idempotencyKey,
  };
  if (branchId) entryData.organizationId = branchId;
  if (input.sourceRef) entryData.sourceRef = input.sourceRef;
  if (input.metadata && Object.keys(input.metadata).length > 0) entryData.metadata = input.metadata;

  const entry = (await journalEntryRepository.create(entryData)) as {
    _id: { toString(): string };
    state?: string;
  };

  // If the ledger short-circuited to the winner, `state` may be what the
  // winner had (e.g. 'posted') — preserve it so we don't re-post an entry
  // the winning caller already posted.
  let state = entry.state ?? 'draft';

  // Auto-post if requested. Ledger strictness.requireActor is on, so we
  // must pass an actorId — use the caller's id when present, else fall back
  // to SYSTEM_ACTOR_ID for background flows (auto-close hook, scheduled jobs).
  // Skip when the ledger already returned a posted winner (idempotent replay).
  if (input.autoPost && state !== 'posted') {
    try {
      await journalEntryRepository.post(entry._id, branchId, {
        actorId: input.actorId ?? SYSTEM_ACTOR_ID,
      });
      state = 'posted';
    } catch (err) {
      logger.warn({ entryId: entry._id, error: (err as Error).message }, 'Auto-post failed, entry remains as draft');
    }
  }

  return { journalEntryId: entry._id.toString(), state };
}

// ─── Convenience: Ensure Company Has Accounts ──────────────────────────────

let _companySeeded = false;

/**
 * Lazy-seed chart of accounts on first accounting access.
 * Idempotent — company-wide, only runs once per process.
 */
export async function ensureCompanyAccounts(): Promise<void> {
  if (_companySeeded) return;

  const count = await Account.countDocuments().limit(1);

  if (count === 0) {
    await accountRepository.seedAccounts(undefined);
    logger.info('Auto-seeded company-wide chart of accounts');
  }

  _companySeeded = true;
}
