/**
 * Open-balance service — subsidiary-ledger settlement math
 *
 * Fintech-correct partial-settlement model for ledger 0.7:
 *
 *   Ledger 0.7's `reconciliations.match()` stamps a shared `matchingNumber`
 *   on every referenced item AND REFUSES to match an item twice
 *   (reconciliation.repository.ts:162-166). That means we cannot
 *   incrementally match partial payments — once matched, an item is locked.
 *
 *   Correct pattern:
 *     1. Post the original bill/invoice JE, unmatched.
 *     2. Post each settlement (payment, credit note, debit note, allowance)
 *        as a separate JE, unmatched, with the SAME sourceRef.sourceId as
 *        the original (linking it to the settlement group).
 *     3. Compute the group's open balance by summing all UNMATCHED items
 *        on the control account tagged with the same partnerId + sourceId.
 *     4. Only when the group's open balance reaches zero do we call
 *        reconciliations.match() on ALL related items at once — locking
 *        the group as fully settled.
 *
 *   An item becomes "open" (in `getOpenItems`) the moment it is posted and
 *   stays open until the group is fully settled and matched. Per-bill
 *   open balance is computed from the unmatched-items set below.
 *
 * All values are paisa (integer cents). No float arithmetic anywhere.
 */

import mongoose from 'mongoose';
import { accounting, JournalEntry } from '../accounting.engine.js';

export type LedgerSide = 'payable' | 'receivable';

export interface BillGroupKey {
  /** Which control account (2111 for A/P, 1141 for A/R) */
  controlAccountId: mongoose.Types.ObjectId;
  /** Supplier._id (payable) or Customer._id (receivable) as string */
  partnerId: string;
  /** Original source id (Purchase._id or Order._id) linking the group */
  sourceId: string;
  /** 'payable' = bill (original is a credit); 'receivable' = invoice (original is a debit) */
  side: LedgerSide;
}

/**
 * All unmatched items belonging to this settlement group. Returned with
 * entry id + item index so the caller can pass them to
 * `reconciliations.match()` once the group fully settles.
 */
export interface GroupItem {
  entryId: mongoose.Types.ObjectId;
  itemIndex: number;
  debit: number;
  credit: number;
  date: Date;
}

/**
 * Find every unmatched journal-item line on `controlAccountId` that carries
 * the given partnerId + sourceRef.sourceId. This is the settlement group
 * for a single bill/invoice.
 */
export async function getGroupItems(key: BillGroupKey): Promise<GroupItem[]> {
  const pipeline: mongoose.PipelineStage[] = [
    {
      $match: {
        state: 'posted',
        // sourceRef.sourceId is an opaque String (ledger convention) — match
        // by string equality, not ObjectId cast.
        'sourceRef.sourceId': String(key.sourceId),
      },
    },
    { $unwind: { path: '$journalItems', includeArrayIndex: 'itemIndex' } },
    {
      $match: {
        'journalItems.account': key.controlAccountId,
        'journalItems.partnerId': key.partnerId,
        $or: [{ 'journalItems.matchingNumber': null }, { 'journalItems.matchingNumber': { $exists: false } }],
      },
    },
    {
      $project: {
        _id: 0,
        entryId: '$_id',
        itemIndex: '$itemIndex',
        debit: { $ifNull: ['$journalItems.debit', 0] },
        credit: { $ifNull: ['$journalItems.credit', 0] },
        date: '$journalItems.date',
      },
    },
  ];
  const rows = (await JournalEntry.aggregate(pipeline)) as Array<{
    entryId: mongoose.Types.ObjectId;
    itemIndex: number;
    debit: number;
    credit: number;
    date: Date;
  }>;
  return rows;
}

/**
 * Net open balance for a bill/invoice settlement group, in paisa.
 *
 *   payable:    sum(credits) - sum(debits)  (original is a credit, payments are debits)
 *   receivable: sum(debits)  - sum(credits) (original is a debit, receipts are credits)
 *
 * Returns 0 when the group is fully settled.
 */
export function computeOpenBalanceFromItems(side: LedgerSide, items: GroupItem[]): number {
  const totalCredit = items.reduce((s, i) => s + (i.credit || 0), 0);
  const totalDebit = items.reduce((s, i) => s + (i.debit || 0), 0);
  return side === 'payable' ? totalCredit - totalDebit : totalDebit - totalCredit;
}

export async function computeOpenBalance(key: BillGroupKey): Promise<number> {
  const items = await getGroupItems(key);
  return computeOpenBalanceFromItems(key.side, items);
}

/**
 * If the group has fully settled (net = 0), atomically match every
 * unmatched item in one call. Safe to call even when the group still has
 * an open balance — it's a no-op then. Returns true if a match happened.
 *
 * No-op when fewer than 2 items exist (match requires ≥2 items in ledger 0.7).
 *
 * Concurrency: ledger 0.7's `reconciliations.match()` enforces "no item
 * matched twice" at the engine level. If two concurrent settle attempts
 * both observe net=0 (TOCTOU race) and both call match(), the second one
 * will throw with an "already matched" conflict. We treat that error as
 * SUCCESS — the group is reconciled either way; the first call won the
 * race. This is the right behavior for a fintech ledger: the invariant
 * "never double-match" is preserved by the engine, and the second caller
 * doesn't care which physical call did it.
 */
export async function maybeSettleGroup(key: BillGroupKey): Promise<boolean> {
  const items = await getGroupItems(key);
  if (items.length < 2) return false;
  const open = computeOpenBalanceFromItems(key.side, items);
  if (open !== 0) return false;

  // ledger 0.7's reconciliations.match() throws AccountingError(409,
  // "already matched") if any referenced item already has a matchingNumber
  // (see packages/ledger/src/repositories/reconciliation.repository.ts:162).
  //
  // Concurrency: under load, two settlement attempts can both observe a
  // group at net=0 and both call match(). The first wins; the second
  // observes its items already stamped and throws. This is the right
  // behavior at the engine level — the invariant "never double-match" is
  // preserved. From the caller's perspective the group is settled either
  // way, so we treat that error as success.
  try {
    await accounting.repositories.reconciliations.match({
      account: key.controlAccountId,
      items: items.map((i) => ({ entry: i.entryId, itemIndex: i.itemIndex })),
    } as never);
    return true;
  } catch (err) {
    const msg = (err as Error).message || '';
    if (/already matched/i.test(msg)) return true;
    // Fallback: re-fetch unmatched items. If the group has been fully
    // matched between our read and our write, that's also success.
    const after = await getGroupItems(key);
    if (after.length === 0) return true;
    throw err;
  }
}
