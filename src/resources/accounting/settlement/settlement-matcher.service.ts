/**
 * Settlement Matcher Service
 *
 * Walks every unmatched leg on every open SettlementImport for a branch +
 * clearing account, looks up the corresponding sales-side debit on the
 * clearing-account JE, and records the link on the leg subdocument.
 *
 * Match algorithm (two-tier — deterministic first, amount fallback second):
 *
 *   TIER 1 — Gateway transaction reference (deterministic, 1:1)
 *     If `leg.externalTxnRef` is set AND a JE with the same
 *     `metadata.gatewayTransactionId` exists in this org, that's an exact
 *     match. Used for Stripe/SSLCommerz/bKash/Nagad/Pathao providers that
 *     stamp a unique transaction id we can carry through both sides.
 *     Strategy: 'gateway_txn_id'.
 *
 *   TIER 2 — Amount + date window (industry baseline, ambiguous on busy days)
 *     Fall back to the original rule: find posted JEs where some journalItem
 *     has the clearing account and a debit equal to `leg.gross`, dated
 *     within `[txnDate - 7d, settlementDate + 1d]`. Used when the gateway
 *     ref isn't stamped (legacy data, manually-entered cash settlements).
 *     Strategy: 'amount_date'.
 *
 *   Both tiers exclude JE lines already pinned by another leg
 *   (first-write-wins). Exactly one free candidate → mark `matchState:
 *   'auto'`. Multiple or zero → leave as `unmatched`; finance reconciles
 *   manually via the API.
 *
 * Journal items have no `_id` (ledger uses `{ _id: false }`), so we identify
 * a matched line by its **array index** within `journalItems`, mirroring the
 * ledger's own match-resolver convention.
 *
 * The two-tier model matches Xero / QBO bank-rec (which prefer matched
 * external references over amount/date) and resolves the ambiguity that
 * would otherwise show up on high-volume bKash days where multiple sales
 * happen for the same amount in the same window.
 */

import mongoose from 'mongoose';
import logger from '#lib/utils/logger.js';
import { JournalEntry } from '../accounting.engine.js';
import { resolveAccountId } from '../posting/posting.service.js';
import settlementImportRepository from './settlement-import.repository.js';

export type MatchStrategy = 'gateway_txn_id' | 'amount_date';

export interface MatchResult {
  importId: string;
  legId: string;
  matched: boolean;
  journalEntryId?: string;
  journalItemIndex?: number;
  reason?: 'no-candidate' | 'ambiguous' | 'matched';
  /** Which tier of the match algorithm fired. Useful for observability:
   *  a sudden drop in `gateway_txn_id` matches signals a payment-bridge
   *  regression that's leaving the JE metadata empty. */
  strategy?: MatchStrategy;
}

export interface MatchSummary {
  scanned: number;
  matched: number;
  ambiguous: number;
  noCandidate: number;
  results: MatchResult[];
}

const MATCH_WINDOW_PRE_MS = 7 * 24 * 60 * 60 * 1000;
const MATCH_WINDOW_POST_MS = 24 * 60 * 60 * 1000;

type JEItem = { account: mongoose.Types.ObjectId; debit: number; credit: number };
type JECandidate = {
  _id: mongoose.Types.ObjectId;
  journalItems: JEItem[];
  metadata?: { gatewayTransactionId?: string; gatewayProvider?: string } & Record<string, unknown>;
};

export async function matchSettlementLegs(
  organizationId: string,
  options: { clearingAccountCode?: string } = {},
): Promise<MatchSummary> {
  const legs = await settlementImportRepository.findUnmatchedLegs(
    organizationId,
    options.clearingAccountCode,
  );

  const summary: MatchSummary = { scanned: legs.length, matched: 0, ambiguous: 0, noCandidate: 0, results: [] };
  if (legs.length === 0) return summary;

  const accountIdCache = new Map<string, mongoose.Types.ObjectId>();
  const getAccountId = async (code: string): Promise<mongoose.Types.ObjectId> => {
    let id = accountIdCache.get(code);
    if (!id) {
      id = await resolveAccountId(code);
      accountIdCache.set(code, id);
    }
    return id;
  };

  const claimedThisRun = new Set<string>();
  const orgObjectId = new mongoose.Types.ObjectId(organizationId);

  for (const leg of legs) {
    const accountId = await getAccountId(leg.clearingAccountCode);
    const dateFrom = new Date(leg.txnDate.getTime() - MATCH_WINDOW_PRE_MS);
    const dateTo = new Date(leg.settlementDate.getTime() + MATCH_WINDOW_POST_MS);

    // TIER 1: Gateway txn ref → deterministic 1:1 match. Skip when leg
    // doesn't carry a ref (legacy data, manual cash settlements).
    let strategy: MatchStrategy = 'amount_date';
    let candidates: JECandidate[] = [];

    if (leg.externalTxnRef) {
      const byTxnRef = (await JournalEntry.find({
        organizationId: orgObjectId,
        state: 'posted',
        'metadata.gatewayTransactionId': leg.externalTxnRef,
        'journalItems.account': accountId,
      })
        .select('_id journalItems metadata')
        .lean()) as unknown as JECandidate[];
      if (byTxnRef.length > 0) {
        candidates = byTxnRef;
        strategy = 'gateway_txn_id';
      }
    }

    // TIER 2: amount + date window fallback.
    if (candidates.length === 0) {
      candidates = (await JournalEntry.find({
        organizationId: orgObjectId,
        state: 'posted',
        date: { $gte: dateFrom, $lte: dateTo },
        'journalItems.account': accountId,
        'journalItems.debit': leg.gross,
      })
        .select('_id journalItems metadata')
        .lean()) as unknown as JECandidate[];
    }

    const matches: Array<{ entryId: string; itemIndex: number }> = [];
    for (const entry of candidates) {
      for (let i = 0; i < entry.journalItems.length; i++) {
        const item = entry.journalItems[i];
        // Tier 1 (txn-ref): pin the clearing-account debit line on the
        // matched JE — amount must still be a credit-leg debit ≥ 0 but not
        // necessarily exactly leg.gross (provider sometimes nets fees on
        // the leg gross). Tier 2 keeps the strict equality check.
        const accountMatches = String(item.account) === String(accountId) && item.credit === 0;
        if (!accountMatches) continue;
        if (strategy === 'amount_date' && item.debit !== leg.gross) continue;
        if (item.debit <= 0) continue;
        const key = `${entry._id}:${i}`;
        if (claimedThisRun.has(key)) continue;
        matches.push({ entryId: String(entry._id), itemIndex: i });
      }
    }

    // Filter out lines already matched by other settlement legs (persisted).
    const persistedClaims = matches.length
      ? await settlementImportRepository.aggregatePipeline<{
          _id: { entryId: string; itemIndex: number };
        }>([
          { $match: { organizationId: orgObjectId } },
          { $unwind: '$legs' },
          {
            $match: {
              'legs.matchedJournalEntryId': { $in: matches.map((m) => new mongoose.Types.ObjectId(m.entryId)) },
            },
          },
          {
            $group: {
              _id: {
                entryId: { $toString: '$legs.matchedJournalEntryId' },
                itemIndex: '$legs.matchedJournalItemIndex',
              },
            },
          },
        ])
      : [];

    const persistedSet = new Set(persistedClaims.map((c) => `${c._id.entryId}:${c._id.itemIndex}`));
    const free = matches.filter((m) => !persistedSet.has(`${m.entryId}:${m.itemIndex}`));

    const legIdStr = String(leg._id ?? '');
    const importIdStr = String(leg.importId);

    if (free.length === 1) {
      const pick = free[0];
      claimedThisRun.add(`${pick.entryId}:${pick.itemIndex}`);
      await settlementImportRepository.findOneAndUpdate(
        { _id: leg.importId, 'legs._id': leg._id },
        {
          $set: {
            'legs.$.matchState': 'auto',
            'legs.$.matchedJournalEntryId': new mongoose.Types.ObjectId(pick.entryId),
            'legs.$.matchedJournalItemIndex': pick.itemIndex,
            'legs.$.matchedAt': new Date(),
            'legs.$.matchStrategy': strategy,
          },
        },
      );
      summary.matched += 1;
      summary.results.push({
        importId: importIdStr,
        legId: legIdStr,
        matched: true,
        journalEntryId: pick.entryId,
        journalItemIndex: pick.itemIndex,
        reason: 'matched',
        strategy,
      });
    } else if (free.length > 1) {
      summary.ambiguous += 1;
      summary.results.push({
        importId: importIdStr,
        legId: legIdStr,
        matched: false,
        reason: 'ambiguous',
        strategy,
      });
    } else {
      summary.noCandidate += 1;
      summary.results.push({
        importId: importIdStr,
        legId: legIdStr,
        matched: false,
        reason: 'no-candidate',
        strategy,
      });
    }
  }

  await markReconciledImports(organizationId);

  logger.info(
    { organizationId, ...summary, results: undefined },
    'Settlement matcher run complete',
  );
  return summary;
}

/**
 * Manual override — finance pins a leg to a JE line the auto-matcher
 * couldn't disambiguate.
 */
export async function manualMatchLeg(params: {
  importId: string;
  legId: string;
  journalEntryId: string;
  journalItemIndex: number;
}): Promise<void> {
  await settlementImportRepository.findOneAndUpdate(
    { _id: params.importId, 'legs._id': params.legId },
    {
      $set: {
        'legs.$.matchState': 'manual',
        'legs.$.matchedJournalEntryId': new mongoose.Types.ObjectId(params.journalEntryId),
        'legs.$.matchedJournalItemIndex': params.journalItemIndex,
        'legs.$.matchedAt': new Date(),
      },
    },
  );
}

async function markReconciledImports(organizationId: string): Promise<void> {
  const candidates = await settlementImportRepository.findAll({
    organizationId,
    status: 'posted',
    reconciledAt: null,
  });

  const fullyMatched = candidates
    .filter((doc) => doc.legs.every((l) => l.matchState !== 'unmatched'))
    .map((doc) => doc._id);

  if (fullyMatched.length === 0) return;

  await settlementImportRepository.updateMany(
    { _id: { $in: fullyMatched } },
    { $set: { status: 'reconciled', reconciledAt: new Date() } },
  );
}
