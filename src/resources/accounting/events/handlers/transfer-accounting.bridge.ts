/**
 * Inter-branch Transfer → Accounting bridge.
 *
 * Subscribes to `transfer:dispatched` and `transfer:received` and posts a
 * pair of journal entries — one tagged with the SENDER branch on dispatch,
 * one with the RECEIVER branch on receive — both touching the company-wide
 * `1179 Inventory in Transit` clearing account.
 *
 *   Dispatch (sender):
 *     Dr 1179 Inventory in Transit
 *     Cr 1165 Merchandise Inventory
 *
 *   Receive (receiver):
 *     Dr 1165 Merchandise Inventory
 *     Cr 1179 Inventory in Transit
 *
 * Net company-level effect is zero — only the per-branch dimension shifts.
 * Same shape as `flow-procurement-received.bridge.ts` (sibling file).
 *
 * Cost source: per-line FIFO unit cost is read from cost layers at the
 * sender's stock location at dispatch time, not trusted from the transfer
 * item's persisted `costPrice` (which is enriched at create time and may
 * be stale / zero when the create-time cost lookup missed). If a line's
 * cost is zero, the JE still posts but with `metadata.costMissing: true`
 * + the affected SKUs — same audit-trail pattern as the COGS handler.
 *
 * Idempotency: `idempotencyKey: transfer-{id}-{dispatch|receive}`. Ledger
 * ≥0.8.1 dedupes via DB-level race-safe key, so duplicate event delivery
 * (retry / replay) returns the same JE without double-posting.
 *
 * Cancellation reversal (`transfer:cancelled` with `wasDispatched: true`)
 * is deferred to phase 2.
 */

import type { DomainEvent } from '@classytic/primitives/events';
import type { Types } from 'mongoose';
import { subscribe } from '#lib/events/arcEvents.js';
import logger from '#lib/utils/logger.js';
import { skuRefFromProduct } from '#resources/inventory/flow/context-helpers.js';
import { buildFlowContext } from '#resources/inventory/flow/context-helpers.js';
import { getFlowEngineOrNull } from '#resources/inventory/flow/flow-engine.js';
import { resolveLocationId } from '#resources/inventory/flow/location-resolver.js';
import { getTransferEngineOrNull } from '#resources/inventory/_engines/transfer.engine.js';
import { createPosting, ensureCompanyAccounts } from '../../posting/posting.service.js';
import {
  transferDispatchReversalToPosting,
  transferDispatchToPosting,
  transferReceiveReversalToPosting,
  transferReceiveToPosting,
} from '../../posting/contracts/transfer.contract.js';

type TransferLineInput = Array<{
  product: string | Types.ObjectId;
  variantSku?: string | null;
  quantity: number;
  costPrice?: number;
  /**
   * Per-line transit / landed cost in major BDT (decimal). Default 0
   * (no transit cost). Summed across lines into the receive JE's
   * 1159 Transfer Cost Clearing line. Sender dispatch leg ignores this.
   */
  transitCost?: number;
  sourceLocationId?: string;
  destinationLocationId?: string;
}>;

interface DispatchedPayload {
  transferId: string;
  documentNumber: string;
  senderBranchId: string;
  items?: TransferLineInput;
  dispatchedBy?: string;
}

interface ReceivedPayload {
  transferId: string;
  documentNumber: string;
  senderBranchId?: string;
  receiverBranchId: string;
  items?: TransferLineInput;
  receivedBy?: string;
  isPartial?: boolean;
}

interface CancelledPayload {
  transferId: string;
  documentNumber: string;
  senderBranchId: string;
  receiverBranchId?: string;
  items?: TransferLineInput;
  reason?: string;
  cancelledBy?: string;
  /** True when the cancel happened AFTER dispatch — dispatch JE needs reversal. */
  wasDispatched?: boolean;
  /** True when the cancel happened AFTER receive — receive JE also needs reversal. */
  wasReceived?: boolean;
}

let registered = false;

/**
 * Load the full transfer document via the engine's repository.
 * Used when the event payload is minimal (engine publishes only IDs, no items/branch fields).
 */
async function loadTransferDoc(transferId: string): Promise<{
  senderBranch: unknown;
  receiverBranch: unknown;
  items: TransferLineInput;
  documentNumber: string;
} | null> {
  const eng = getTransferEngineOrNull();
  if (!eng) return null;
  return eng.repositories.stockTransfer.getById(transferId, { lean: true }) as Promise<{
    senderBranch: unknown;
    receiverBranch: unknown;
    items: TransferLineInput;
    documentNumber: string;
  } | null>;
}

interface ResolvedCost {
  /** Sum of (qty × unitCost) across resolvable lines, in paisa. */
  goodsPaisa: number;
  /**
   * Sum of per-line `transitCost` across all lines, in paisa. Capitalized
   * into receiver inventory at receive time and credited to 1159. Always
   * computed regardless of whether goods cost was resolvable.
   */
  transitPaisa: number;
  /** SKUs whose goods unitCost couldn't be resolved (cost layer empty). */
  missing: string[];
}

/**
 * Resolve goods + transit costs (paisa) for a transfer's lines using the
 * `costSourceBranch`'s cost layers for goods and the persisted per-line
 * `transitCost` for transit.
 *
 * Goods cost: line `costPrice` if non-zero, otherwise FIFO unit cost from
 * the cost layer at the line's `sourceLocationId` (falling back to the
 * branch's default `stock` location). Lines with zero goods cost are
 * surfaced via `missing` so the bridge can stamp `costMissing` metadata.
 *
 * Transit cost: sum of per-line `transitCost` (BDT major → paisa). No
 * cost-layer lookup needed — transit is a host-supplied value.
 */
async function resolveCostFromBranch(
  flow: ReturnType<typeof getFlowEngineOrNull>,
  branchId: string,
  actorId: string,
  items: TransferLineInput,
): Promise<ResolvedCost> {
  let transitPaisa = 0;
  for (const item of items) {
    const transit = Number(item.transitCost ?? 0);
    if (transit > 0) transitPaisa += Math.round(transit * 100);
  }

  if (!flow) return { goodsPaisa: 0, transitPaisa, missing: [] };
  const ctx = buildFlowContext(branchId, actorId);

  const node = await flow.repositories.node.getByQuery(
    { isDefault: true },
    { organizationId: branchId, throwOnNotFound: false, lean: true },
  );
  const fallbackNodeId = node ? String((node as { _id: unknown })._id) : undefined;

  let goodsPaisa = 0;
  const missing: string[] = [];

  for (const item of items) {
    const skuRef = skuRefFromProduct(item.product, item.variantSku);
    const qty = Number(item.quantity ?? 0);
    if (qty <= 0) continue;

    let unitCost = Number(item.costPrice ?? 0);

    if (unitCost <= 0) {
      try {
        const locationId = await resolveLocationId(flow, item.sourceLocationId, ctx, {
          fallbackNodeId,
        });
        const valuation = await flow.services.costLayer.getValuation(skuRef, locationId, ctx);
        unitCost = Number(valuation?.averageUnitCost ?? 0);
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, skuRef },
          '[accounting] transfer bridge: cost-layer lookup failed',
        );
      }
    }

    if (unitCost <= 0) {
      missing.push(skuRef);
      continue;
    }
    goodsPaisa += Math.round(qty * unitCost * 100);
  }

  return { goodsPaisa, transitPaisa, missing };
}

export function registerTransferAccountingBridge(): void {
  if (registered) return;
  registered = true;

  // ── Dispatch leg ──────────────────────────────────────────────────────
  void subscribe('transfer:dispatched', async (event: DomainEvent) => {
    const payload = (event.payload ?? {}) as DispatchedPayload;
    if (!payload.transferId) return;

    // Engine event payloads are minimal (no senderBranchId/items) — fall back
    // to loading the full document so the accounting bridge remains engine-agnostic.
    let branchId = payload.senderBranchId ?? event.meta?.organizationId ?? '';
    let items: TransferLineInput | undefined = payload.items;

    if (!branchId || !items?.length) {
      const doc = await loadTransferDoc(payload.transferId);
      if (!doc) return;
      branchId = branchId || String(doc.senderBranch);
      if (!items?.length) items = doc.items;
    }

    if (!branchId || !items?.length) return;

    try {
      const flow = getFlowEngineOrNull();
      // Dispatch leg only cares about goods cost. Transit cost is a
      // receiver-side capitalization, not a sender-side outflow.
      const { goodsPaisa, missing } = await resolveCostFromBranch(
        flow,
        branchId,
        payload.dispatchedBy ?? '',
        items,
      );

      await ensureCompanyAccounts();

      const posting = transferDispatchToPosting({
        transferId: payload.transferId,
        documentNumber: payload.documentNumber ?? '',
        goodsCost: goodsPaisa,
        date: new Date(),
        ...(missing.length ? { metadata: { costMissing: true, affectedSkus: missing } } : {}),
      });

      const result = await createPosting(branchId, posting);
      logger.info(
        {
          event: 'transfer:dispatched',
          documentNumber: payload.documentNumber,
          journalEntryId: result.journalEntryId,
          goodsPaisa,
          costMissing: missing.length > 0,
        },
        '[accounting] transfer dispatched: JE posted',
      );
    } catch (err) {
      logger.error(
        { err: (err as Error).message, documentNumber: payload.documentNumber },
        '[accounting] transfer-dispatched bridge failed',
      );
    }
  });

  // ── Receive leg ───────────────────────────────────────────────────────
  void subscribe('transfer:received', async (event: DomainEvent) => {
    const payload = (event.payload ?? {}) as ReceivedPayload;
    if (!payload.transferId) return;

    // Engine event payloads are minimal — fall back to the full document.
    let branchId = payload.receiverBranchId ?? event.meta?.organizationId ?? '';
    let senderBranchId = payload.senderBranchId;
    let items: TransferLineInput | undefined = payload.items;

    if (!branchId || !senderBranchId || !items?.length) {
      const doc = await loadTransferDoc(payload.transferId);
      if (!doc) return;
      branchId = branchId || String(doc.receiverBranch);
      senderBranchId = senderBranchId || String(doc.senderBranch);
      if (!items?.length) items = doc.items;
    }

    if (!branchId || !items?.length) return;

    try {
      const flow = getFlowEngineOrNull();
      // Receive leg goods cost MUST come from the SENDER's cost layers —
      // the receiver doesn't have layers for this SKU yet (they're being
      // created by this very receive). Transit cost is a receiver-side
      // capitalization sourced from the line's `transitCost` regardless
      // of branch.
      const costSourceBranchId = senderBranchId ?? branchId;
      const { goodsPaisa, transitPaisa, missing } = await resolveCostFromBranch(
        flow,
        costSourceBranchId,
        payload.receivedBy ?? '',
        items,
      );

      await ensureCompanyAccounts();

      const posting = transferReceiveToPosting({
        transferId: payload.transferId,
        documentNumber: payload.documentNumber ?? '',
        goodsCost: goodsPaisa,
        ...(transitPaisa > 0 ? { transitCost: transitPaisa } : {}),
        date: new Date(),
        ...(missing.length ? { metadata: { costMissing: true, affectedSkus: missing } } : {}),
      });

      const result = await createPosting(branchId, posting);
      logger.info(
        {
          event: 'transfer:received',
          documentNumber: payload.documentNumber,
          journalEntryId: result.journalEntryId,
          goodsPaisa,
          transitPaisa,
          isPartial: payload.isPartial ?? false,
          costMissing: missing.length > 0,
        },
        '[accounting] transfer received: JE posted',
      );
    } catch (err) {
      logger.error(
        { err: (err as Error).message, documentNumber: payload.documentNumber },
        '[accounting] transfer-received bridge failed',
      );
    }
  });

  // ── Cancellation reversal ────────────────────────────────────────────
  // Defensive: today's state machine only allows cancel from draft/approved
  // (no JE has been posted yet → bridge no-ops). Wired anyway so a future
  // expansion to allow forced post-dispatch cancellation produces correct
  // accounting reversals automatically.
  void subscribe('transfer:cancelled', async (event: DomainEvent) => {
    const payload = (event.payload ?? {}) as CancelledPayload;
    const senderBranchId = payload.senderBranchId ?? event.meta?.organizationId ?? '';
    const receiverBranchId = payload.receiverBranchId;

    if (!payload.transferId || !senderBranchId) return;
    if (!payload.wasDispatched) {
      // No prior JE to reverse — common path (cancel from draft/approved).
      return;
    }
    if (!payload.items?.length) return;

    try {
      const flow = getFlowEngineOrNull();
      const { goodsPaisa, transitPaisa, missing } = await resolveCostFromBranch(
        flow,
        senderBranchId,
        payload.cancelledBy ?? '',
        payload.items,
      );

      await ensureCompanyAccounts();

      // Always reverse the dispatch leg when wasDispatched. Dispatch only
      // touched goods cost; the reversal mirrors that.
      const dispatchReversal = transferDispatchReversalToPosting({
        transferId: payload.transferId,
        documentNumber: payload.documentNumber,
        goodsCost: goodsPaisa,
        date: new Date(),
        ...(payload.reason ? { reason: payload.reason } : {}),
        ...(missing.length ? { metadata: { costMissing: true, affectedSkus: missing } } : {}),
      });
      const dispatchRes = await createPosting(senderBranchId, dispatchReversal);
      logger.info(
        {
          event: 'transfer:cancelled',
          documentNumber: payload.documentNumber,
          journalEntryId: dispatchRes.journalEntryId,
          goodsPaisa,
          leg: 'dispatch',
        },
        '[accounting] transfer cancelled: dispatch reversal posted',
      );

      // Also reverse the receive leg when the cancel happened post-receive.
      // Receive reversal includes transit cost (uncapitalize from receiver
      // inventory + restore the 1159 clearing balance).
      if (payload.wasReceived && receiverBranchId) {
        const receiveReversal = transferReceiveReversalToPosting({
          transferId: payload.transferId,
          documentNumber: payload.documentNumber,
          goodsCost: goodsPaisa,
          ...(transitPaisa > 0 ? { transitCost: transitPaisa } : {}),
          date: new Date(),
          ...(payload.reason ? { reason: payload.reason } : {}),
          ...(missing.length ? { metadata: { costMissing: true, affectedSkus: missing } } : {}),
        });
        const receiveRes = await createPosting(receiverBranchId, receiveReversal);
        logger.info(
          {
            event: 'transfer:cancelled',
            documentNumber: payload.documentNumber,
            journalEntryId: receiveRes.journalEntryId,
            goodsPaisa,
            transitPaisa,
            leg: 'receive',
          },
          '[accounting] transfer cancelled: receive reversal posted',
        );
      }
    } catch (err) {
      logger.error(
        { err: (err as Error).message, documentNumber: payload.documentNumber },
        '[accounting] transfer-cancelled bridge failed',
      );
    }
  });

  logger.info('[accounting] transfer bridge registered');
}
