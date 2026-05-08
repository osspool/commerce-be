/**
 * Partner Posting Helpers — shared scaffolding for A/R + A/P actions.
 *
 * customer-invoice.actions.ts (A/R) and vendor-bill.actions.ts (A/P) used
 * to carry mirror copies of these helpers — same shape, different control
 * account code and naming. Consolidated here so the two action files stay
 * in lockstep.
 *
 * Naming is partner-neutral: `sourceId` (Order or PurchaseOrder),
 * `partnerId` (customer or supplier), `controlAccountId` (A/R or A/P).
 */

import { getOrgId, getUserId } from '@classytic/arc/scope';
import type { RequestWithExtras } from '@classytic/arc/types';
import mongoose from 'mongoose';
import { Account, journalEntryRepository } from '../accounting.engine.js';
import type { BillGroupKey } from './open-balance.service.js';
import { SYSTEM_ACTOR_ID } from './posting.service.js';

export function getIds(req: RequestWithExtras): { orgId: string | undefined; actorId: string } {
  const orgId = getOrgId(req.scope) ?? undefined;
  const actorId = (getUserId(req.scope) ?? req.user?._id ?? req.user?.id ?? SYSTEM_ACTOR_ID) as string;
  return { orgId, actorId };
}

export function assertPositiveIntegerPaisa(amount: unknown): asserts amount is number {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
    throw Object.assign(new Error('amount must be a positive integer (paisa)'), {
      statusCode: 400,
      code: 'INVALID_AMOUNT',
    });
  }
}

/**
 * Look up a control account `_id` by `accountTypeCode` (e.g. '1141' for A/R,
 * '2111' for A/P). Throws CHART_NOT_SEEDED (503) if missing.
 */
export async function controlAccountId(accountTypeCode: string): Promise<mongoose.Types.ObjectId> {
  const acc = await Account.findOne({ accountTypeCode }).select('_id').lean();
  if (!acc) {
    throw Object.assign(new Error(`Control account ${accountTypeCode} not seeded`), {
      statusCode: 503,
      code: 'CHART_NOT_SEEDED',
    });
  }
  return acc._id as mongoose.Types.ObjectId;
}

export interface PartnerContext {
  /** Source document id — Order for A/R, PurchaseOrder for A/P. */
  sourceId: string;
  /** Partner id — customer for A/R, supplier for A/P. */
  partnerId: string;
  branchId?: string;
  /** Control account id (A/R or A/P) used to find the partner-tagged JE line. */
  controlAccountId: mongoose.Types.ObjectId;
  /** Open-balance group key — bill, payments, and notes share the same key. */
  groupKey: BillGroupKey;
}

interface LoadPartnerContextOptions {
  /** Journal entry `_id` of the originating bill / invoice. */
  jeId: string;
  /** 'receivable' for A/R, 'payable' for A/P. */
  side: 'receivable' | 'payable';
  /** accountTypeCode of the control account ('1141' = A/R, '2111' = A/P). */
  controlCode: string;
  /** Human label for error messages, e.g. "Invoice" or "Bill". */
  docLabel: string;
  /** 404 error code, e.g. "INVOICE_NOT_FOUND" or "BILL_NOT_FOUND". */
  notFoundCode: string;
  /** 400 error code when the partner-tagged control line is missing. */
  notPartnerDocCode: string;
  /** 400 error message when the partner-tagged control line is missing. */
  notPartnerDocMessage: string;
}

/**
 * Load a JE, find its partner-tagged control line, and return a normalized
 * `PartnerContext` for receipts / payments / credit-debit notes.
 */
export async function loadPartnerContext(opts: LoadPartnerContextOptions): Promise<PartnerContext> {
  const je = (await journalEntryRepository.getById(opts.jeId, {
    lean: true,
    throwOnNotFound: false,
  })) as
    | {
        _id: mongoose.Types.ObjectId | string;
        journalItems: Array<{ account: mongoose.Types.ObjectId; partnerId?: string }>;
      }
    | null;
  if (!je) {
    throw Object.assign(new Error(`${opts.docLabel} not found`), {
      statusCode: 404,
      code: opts.notFoundCode,
    });
  }
  const accountId = await controlAccountId(opts.controlCode);
  const items = je.journalItems;
  const controlLine = items.find((i) => String(i.account) === String(accountId));
  if (!controlLine || !controlLine.partnerId) {
    throw Object.assign(new Error(opts.notPartnerDocMessage), {
      statusCode: 400,
      code: opts.notPartnerDocCode,
    });
  }
  const sourceRef = (je as { sourceRef?: { sourceId?: unknown } }).sourceRef;
  const sourceId = sourceRef?.sourceId ? String(sourceRef.sourceId) : String(je._id);
  const branchId = (je as { organizationId?: unknown }).organizationId?.toString();
  return {
    sourceId,
    partnerId: controlLine.partnerId,
    branchId,
    controlAccountId: accountId,
    groupKey: {
      controlAccountId: accountId,
      partnerId: controlLine.partnerId,
      sourceId,
      side: opts.side,
    },
  };
}
