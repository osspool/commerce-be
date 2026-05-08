/**
 * Inter-branch Transfer Posting Contract
 *
 * Inter-branch stock transfers post a pair of journal entries — one tagged
 * with the sender branch on dispatch, one tagged with the receiver branch
 * on receive — both touching the company-wide `1179 Inventory in Transit`
 * clearing account. Net company-level effect on inventory is zero; only
 * the per-branch dimension shifts.
 *
 *   Dispatch (sender branch):
 *     Dr 1179 Inventory in Transit            goodsCost
 *     Cr 1164 Merchandise / Trading Goods     goodsCost
 *
 *   Receive (receiver branch):
 *     Dr 1164 Merchandise / Trading Goods     goodsCost + transitCost
 *     Cr 1179 Inventory in Transit            goodsCost
 *     Cr 2126 Transfer Cost Clearing          transitCost   (only if > 0)
 *
 * The clearing account decouples the two legs in time — between dispatch
 * and receive, `1179` carries the in-flight value at the company level.
 *
 * Transit cost capitalization (IAS 2): when the transfer carries a non-zero
 * `transitCost`, the receiver's inventory is uplifted by that amount. The
 * credit lands on `2126 Transfer Cost Clearing` so the host can reconcile
 * it against the actual freight invoice (Dr 2126 / Cr AP) when the bill
 * arrives. This is the industry-standard inter-branch transit treatment
 * (Odoo's "Transit Location" + landed-cost adjustment).
 */

import { BD } from '../bd-account-codes.js';
import type { PostingInput, PostingItem } from '../posting.service.js';

export interface TransferDispatchData {
  transferId: string;
  documentNumber: string;
  goodsCost: number; // paisa — sum of (qty × unitCost) across dispatched lines
  date: Date;
  /**
   * Forwarded onto the journal entry. The bridge attaches `costMissing: true`
   * + `affectedSkus: [...]` when one or more line costs couldn't be resolved
   * from cost layers; the entry still posts (with zero amount lines) so
   * finance has an audit trail.
   */
  metadata?: Record<string, unknown>;
}

export interface TransferReceiveData {
  transferId: string;
  documentNumber: string;
  /** Goods cost in paisa — must match the dispatch leg total. */
  goodsCost: number;
  /**
   * Sum of per-line transit / landed costs in paisa. Capitalized into
   * receiver's inventory and credited to 2126 Transfer Cost Clearing.
   * Default 0 when no transit cost is associated with the transfer.
   */
  transitCost?: number;
  date: Date;
  metadata?: Record<string, unknown>;
}

export function transferDispatchToPosting(
  data: TransferDispatchData,
  options: { autoPost?: boolean } = {},
): PostingInput {
  const items: PostingItem[] = [
    {
      accountCode: BD.inventoryInTransit,
      debit: data.goodsCost,
      credit: 0,
      label: 'Stock dispatched (in-transit)',
    },
    {
      accountCode: BD.merchandise,
      debit: 0,
      credit: data.goodsCost,
      label: 'Inventory reduction (sender)',
    },
  ];

  return {
    journalType: 'INVENTORY',
    label: `Transfer Dispatch — ${data.documentNumber}`,
    date: data.date,
    items,
    idempotencyKey: `transfer-${data.transferId}-dispatch`,
    sourceRef: { sourceModel: 'Transfer', sourceId: data.transferId },
    autoPost: options.autoPost ?? true,
    ...(data.metadata ? { metadata: data.metadata } : {}),
  };
}

export function transferReceiveToPosting(
  data: TransferReceiveData,
  options: { autoPost?: boolean } = {},
): PostingInput {
  const transit = Math.max(0, Number(data.transitCost ?? 0));
  const total = data.goodsCost + transit;

  const items: PostingItem[] = [
    {
      accountCode: BD.merchandise,
      debit: total,
      credit: 0,
      label:
        transit > 0
          ? 'Inventory addition (receiver, incl. capitalized transit cost)'
          : 'Inventory addition (receiver)',
    },
    {
      accountCode: BD.inventoryInTransit,
      debit: 0,
      credit: data.goodsCost,
      label: 'In-transit cleared',
    },
  ];

  if (transit > 0) {
    items.push({
      accountCode: BD.transferCostClearing,
      debit: 0,
      credit: transit,
      label: 'Transit cost clearing (host clears against freight invoice)',
    });
  }

  return {
    journalType: 'INVENTORY',
    label: `Transfer Receive — ${data.documentNumber}`,
    date: data.date,
    items,
    idempotencyKey: `transfer-${data.transferId}-receive`,
    sourceRef: { sourceModel: 'Transfer', sourceId: data.transferId },
    autoPost: options.autoPost ?? true,
    ...(data.metadata ? { metadata: data.metadata } : {}),
  };
}

// ── Cancellation reversals ───────────────────────────────────────────────
//
// When a transfer is cancelled AFTER dispatch (state machine forceCancel
// from a post-dispatch state), the posted JEs need balancing reversals so
// per-branch P&L reflects the undo. We post NEW JEs (not amend existing) —
// accounting convention is that posted entries are immutable; the audit
// trail shows both the original and its reversal.
//
//   Dispatch reversal (sender branch tag):
//     Dr 1164 Merchandise   ← stock comes back to sender
//     Cr 1179 Inventory in Transit ← in-transit cleared on sender's books
//
//   Receive reversal (receiver branch tag) — only fires if the transfer
//   was already received before cancellation:
//     Dr 1179 Inventory in Transit ← in-transit reasserted
//     Dr 2126 Transfer Cost Clearing (if transit cost was capitalized) — restore
//     Cr 1164 Merchandise   ← stock removed from receiver (goods + transit)
//
// Idempotency keys carry the `-reversed` suffix so a cancel-then-replay
// produces at-most-one reversal JE per leg.

export interface TransferDispatchReversalData extends TransferDispatchData {
  reason?: string;
}

export interface TransferReceiveReversalData extends TransferReceiveData {
  reason?: string;
}

export function transferDispatchReversalToPosting(
  data: TransferDispatchReversalData,
  options: { autoPost?: boolean } = {},
): PostingInput {
  const items: PostingItem[] = [
    {
      accountCode: BD.merchandise,
      debit: data.goodsCost,
      credit: 0,
      label: 'Stock returned to sender (dispatch reversed)',
    },
    {
      accountCode: BD.inventoryInTransit,
      debit: 0,
      credit: data.goodsCost,
      label: 'In-transit reversed',
    },
  ];

  return {
    journalType: 'INVENTORY',
    label: `Transfer Dispatch REVERSED — ${data.documentNumber}${data.reason ? ` — ${data.reason}` : ''}`,
    date: data.date,
    items,
    idempotencyKey: `transfer-${data.transferId}-dispatch-reversed`,
    sourceRef: { sourceModel: 'Transfer', sourceId: data.transferId },
    autoPost: options.autoPost ?? true,
    ...(data.metadata ? { metadata: data.metadata } : {}),
  };
}

export function transferReceiveReversalToPosting(
  data: TransferReceiveReversalData,
  options: { autoPost?: boolean } = {},
): PostingInput {
  const transit = Math.max(0, Number(data.transitCost ?? 0));
  const total = data.goodsCost + transit;

  const items: PostingItem[] = [
    {
      accountCode: BD.inventoryInTransit,
      debit: data.goodsCost,
      credit: 0,
      label: 'In-transit reasserted (receive reversed)',
    },
  ];

  if (transit > 0) {
    items.push({
      accountCode: BD.transferCostClearing,
      debit: transit,
      credit: 0,
      label: 'Transit cost clearing reversed',
    });
  }

  items.push({
    accountCode: BD.merchandise,
    debit: 0,
    credit: total,
    label: 'Stock removed from receiver (goods + transit)',
  });

  return {
    journalType: 'INVENTORY',
    label: `Transfer Receive REVERSED — ${data.documentNumber}${data.reason ? ` — ${data.reason}` : ''}`,
    date: data.date,
    items,
    idempotencyKey: `transfer-${data.transferId}-receive-reversed`,
    sourceRef: { sourceModel: 'Transfer', sourceId: data.transferId },
    autoPost: options.autoPost ?? true,
    ...(data.metadata ? { metadata: data.metadata } : {}),
  };
}
