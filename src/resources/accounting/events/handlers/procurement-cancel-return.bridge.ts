/**
 * Flow Procurement → Accounting reversal bridge.
 *
 * Mirrors `flow-procurement-received.bridge.ts` symmetrically:
 *
 *   PO received      → vendor-bill JE  (Dr Inventory / Cr A/P)            ← that bridge
 *   PO cancelled     → reversal JE    (Dr A/P / Cr Inventory)             ← here
 *   PO partial-return→ supplier-return JE (Dr A/P / Cr Inventory, sized)  ← here
 *
 * Subscribes to two flow kernel events:
 *
 *   `flow.procurement.cancelled` — emitted by `procurement.service.cancel()`.
 *     Carries `hadReceipts` so we no-op cleanly when no JE was ever posted
 *     (cancel-from-draft is the common path). `force=true` cancels of
 *     received POs always carry `hadReceipts: true`.
 *
 *   `flow.procurement.supplier_returned` — emitted by be-prod's supplier-
 *     return route after the move group commits. Carries the returned line
 *     quantities and original unit costs so we can size the JE without
 *     re-fetching the PO.
 *
 * Posting contracts come from `posting/contracts/vendor-bill.contract.ts`
 * (`vendorBillReversalToPosting`, `supplierReturnToPosting`). Both stamp
 * `sourceRef.{sourceModel:'PurchaseOrder',sourceId}` so the audit trail
 * lookup (`/accounting/journal-entries/by-source`) pairs original + reversal
 * for the procurement detail page.
 *
 * Idempotency: each posting carries an `idempotencyKey` shaped
 *   - `vendor-bill-{purchaseId}-reverse` (cancel reversal)
 *   - `supplier-return-{purchaseId}-{moveGroupId}` (per-return)
 * so retries collapse to one JE per logical event. The ledger refuses
 * second writes with the same key.
 */
import type { DomainEvent } from '@classytic/primitives/events';
import { subscribe } from '#lib/events/arcEvents.js';
import { majorToMinor } from '#shared/money.js';
import logger from '#lib/utils/logger.js';
import { getFlowEngineOrNull } from '#resources/inventory/flow/flow-engine.js';
import {
  supplierReturnToPosting,
  vendorBillReversalToPosting,
} from '../../posting/contracts/vendor-bill.contract.js';
import { createPosting, ensureCompanyAccounts } from '../../posting/posting.service.js';

interface ProcurementCancelledPayload {
  organizationId: string;
  orderId: string;
  orderNumber: string;
  vendorRef: string;
  reason?: string;
  hadReceipts: boolean;
  priorStatus: string;
}

interface ProcurementSupplierReturnedPayload {
  organizationId: string;
  orderId: string;
  orderNumber: string;
  vendorRef: string;
  moveGroupId: string;
  lines: Array<{
    skuRef: string;
    quantityReturned: number;
    unitCost?: number;
  }>;
  reason?: string;
}

let registered = false;

interface ProcurementOrderRow {
  _id: unknown;
  status?: string;
  receivedAt?: Date;
  items?: Array<{
    skuRef: string;
    quantity?: number;
    quantityReceived?: number;
    unitCost?: number;
    tax?: number;
    taxRate?: number;
  }>;
}

/**
 * Recompute the gross / tax that the original `vendorBillToPosting` saw, by
 * reading the PO from flow's repo. Same math as the receive bridge so the
 * reversal is mass-balanced to the cent — we deliberately re-derive rather
 * than threading the original totals through the cancel event payload.
 *
 * Returns `null` when the PO can't be loaded (already deleted) or when the
 * computed gross is zero (no JE was ever posted to reverse).
 */
async function deriveBillTotals(
  branchId: string,
  orderId: string,
): Promise<{
  totalAmountPaisa: number;
  taxPaisa: number;
  dominantTaxRate: number | undefined;
} | null> {
  const flow = getFlowEngineOrNull();
  if (!flow) return null;

  const order = (await flow.repositories.procurement.getByQuery(
    { _id: orderId },
    { organizationId: branchId, throwOnNotFound: false, lean: true },
  )) as ProcurementOrderRow | null;
  if (!order) return null;

  const items = order.items ?? [];
  const netMajor = items.reduce(
    (s, it) => s + Number(it.quantityReceived ?? it.quantity ?? 0) * Number(it.unitCost ?? 0),
    0,
  );
  const taxMajor = items.reduce((s, it) => {
    if (it.tax != null) return s + Number(it.tax);
    const qty = Number(it.quantityReceived ?? it.quantity ?? 0);
    const rate = Number(it.taxRate ?? 0);
    if (rate <= 0 || qty <= 0) return s;
    return s + (qty * Number(it.unitCost ?? 0) * rate) / 100;
  }, 0);
  const dominantTaxRate = items.find((it) => Number(it.taxRate ?? 0) > 0)?.taxRate ?? undefined;
  const grossMajor = netMajor + taxMajor;
  if (grossMajor <= 0) return null;

  return {
    totalAmountPaisa: majorToMinor(grossMajor),
    taxPaisa: majorToMinor(taxMajor),
    dominantTaxRate,
  };
}

export function registerProcurementCancelReturnBridge(): void {
  if (registered) return;
  registered = true;

  // ── Cancellation reversal ────────────────────────────────────────────
  void subscribe('flow.procurement.cancelled', async (event: DomainEvent) => {
    const payload = (event.payload ?? {}) as ProcurementCancelledPayload;
    const branchId = payload.organizationId ?? event.meta?.organizationId ?? '';
    if (!payload.orderId || !branchId) return;
    if (!payload.hadReceipts) {
      // Cancel-from-draft: nothing was posted, nothing to reverse.
      return;
    }

    try {
      const totals = await deriveBillTotals(branchId, payload.orderId);
      if (!totals) {
        logger.warn(
          { orderId: payload.orderId, orderNumber: payload.orderNumber },
          '[accounting] procurement cancel: order not found or zero total — skipping reversal',
        );
        return;
      }

      await ensureCompanyAccounts();

      const posting = vendorBillReversalToPosting({
        purchaseId: payload.orderId,
        supplierId: payload.vendorRef,
        totalAmount: totals.totalAmountPaisa,
        tax: totals.taxPaisa,
        ...(totals.dominantTaxRate !== undefined ? { vatRate: totals.dominantTaxRate } : {}),
        date: new Date(),
        ...(payload.reason ? { reason: payload.reason } : {}),
      });

      const result = await createPosting(branchId, posting);
      logger.info(
        {
          event: 'flow.procurement.cancelled',
          orderNumber: payload.orderNumber,
          journalEntryId: result.journalEntryId,
          totalAmountPaisa: totals.totalAmountPaisa,
        },
        '[accounting] procurement cancelled: reversal JE posted',
      );
    } catch (err) {
      logger.error(
        { err: (err as Error).message, orderNumber: payload.orderNumber },
        '[accounting] procurement-cancelled bridge failed',
      );
    }
  });

  // ── Supplier return ──────────────────────────────────────────────────
  void subscribe('flow.procurement.supplier_returned', async (event: DomainEvent) => {
    const payload = (event.payload ?? {}) as ProcurementSupplierReturnedPayload;
    const branchId = payload.organizationId ?? event.meta?.organizationId ?? '';
    if (!payload.orderId || !branchId || !payload.lines?.length) return;

    try {
      // Backfill missing unit costs from the PO if any line lacks one.
      let lines = payload.lines;
      const missingCost = lines.some((l) => l.unitCost == null);
      if (missingCost) {
        const flow = getFlowEngineOrNull();
        const order = flow
          ? ((await flow.repositories.procurement.getByQuery(
              { _id: payload.orderId },
              { organizationId: branchId, throwOnNotFound: false, lean: true },
            )) as ProcurementOrderRow | null)
          : null;
        if (order?.items?.length) {
          const costBySku = new Map<string, number>();
          for (const it of order.items) {
            if (it.unitCost != null) costBySku.set(it.skuRef, Number(it.unitCost));
          }
          lines = lines.map((l) => ({
            ...l,
            unitCost: l.unitCost ?? costBySku.get(l.skuRef) ?? 0,
          }));
        }
      }

      await ensureCompanyAccounts();

      const posting = supplierReturnToPosting({
        purchaseId: payload.orderId,
        supplierId: payload.vendorRef,
        moveGroupId: payload.moveGroupId,
        lines,
        date: new Date(),
        ...(payload.reason ? { reason: payload.reason } : {}),
      });

      const result = await createPosting(branchId, posting);
      logger.info(
        {
          event: 'flow.procurement.supplier_returned',
          orderNumber: payload.orderNumber,
          moveGroupId: payload.moveGroupId,
          journalEntryId: result.journalEntryId,
          lineCount: lines.length,
        },
        '[accounting] supplier return: offset JE posted',
      );
    } catch (err) {
      logger.error(
        { err: (err as Error).message, orderNumber: payload.orderNumber },
        '[accounting] procurement-supplier-returned bridge failed',
      );
    }
  });

  logger.info('[accounting] procurement-cancel-return bridge registered');
}
