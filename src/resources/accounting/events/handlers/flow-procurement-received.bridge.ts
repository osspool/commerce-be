/**
 * Flow Procurement → Accounting (vendor bill A/P) bridge.
 *
 * Subscribes to `flow.procurement.received` and posts a vendor-bill
 * accrual JE when a Flow procurement order reaches `received` status
 * (i.e. fully received). Mirrors the legacy `purchase:received` →
 * `purchase-received.handler.ts` flow but reads from Flow's
 * procurement collection instead of `purchase_orders`.
 *
 * Why a separate bridge: the accounting `purchase-received` handler is
 * tied to the legacy collection shape. Flow's procurement model has a
 * different shape (no grandTotal, no tax pre-computed) and is read via
 * the engine repository — not raw Mongo. Keeping the two paths
 * independent avoids regressing the legacy POs.
 *
 * Posting strategy:
 *   - **Full receipt only (`status === 'received'`).** Partial receipts
 *     skip — accruing per-line on partials would either over-post
 *     (double counting on subsequent receipts) or require deltas the
 *     event payload doesn't carry today. The simple-and-correct path
 *     is to wait for completion. Hosts that need partial-accrual can
 *     subscribe to `flow.procurement.foreign_receipt` (FX-stamped, line
 *     level) and run their own contract.
 *   - Total = sum(items: quantity × unitCost). Tax = 0 (Flow doesn't
 *     model tax; host concern).
 *   - Idempotency: the underlying `createPosting` writes a JE per call
 *     keyed off `posting.metadata.sourceRef` (the procurement id). If
 *     the bridge fires twice (retry), we duplicate. Acceptable for now;
 *     proper dedup would attach a JE on the procurement doc itself.
 */
import type { DomainEvent } from '@classytic/primitives/events';
import { subscribe } from '#lib/events/arcEvents.js';
import logger from '#lib/utils/logger.js';
import { getFlowEngineOrNull } from '#resources/inventory/flow/flow-engine.js';
import Supplier from '#resources/inventory/supplier/models/supplier.model.js';
import { vendorBillToPosting } from '../../posting/contracts/vendor-bill.contract.js';
import { createPosting, ensureCompanyAccounts } from '../../posting/posting.service.js';

interface ProcurementReceivedPayload {
  organizationId: string;
  orderId: string;
  orderNumber: string;
  vendorRef: string;
  destinationNodeId: string;
  itemCount: number;
  isPartial?: boolean;
}

let registered = false;

export function registerFlowProcurementAccountingBridge(): void {
  if (registered) return;
  registered = true;

  void subscribe('flow.procurement.received', async (event: DomainEvent) => {
    const payload = (event.payload ?? {}) as ProcurementReceivedPayload;
    const branchId = payload.organizationId ?? event.meta?.organizationId ?? '';
    if (!payload.orderId || !payload.vendorRef || !branchId) return;

    const flow = getFlowEngineOrNull();
    if (!flow) return;

    try {
      const order = (await flow.repositories.procurement.getByQuery(
        { _id: payload.orderId },
        { organizationId: branchId, throwOnNotFound: false, lean: true },
      )) as
        | {
            _id: unknown;
            status?: string;
            orderNumber?: string;
            vendorRef?: string;
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
        | null;

      if (!order) return;

      // Only post on fully received. Partial receipts skip — see header.
      if (order.status !== 'received') return;

      const items = order.items ?? [];
      // Net cost in major BDT: sum of quantityReceived × unitCost across
      // all lines. `unitCost` on Flow procurement items is the
      // net-of-recoverable-VAT cost (BD GAAP-aligned), so this number
      // rolls up into the inventory debit unchanged.
      const netMajor = items.reduce(
        (s, it) =>
          s + Number(it.quantityReceived ?? it.quantity ?? 0) * Number(it.unitCost ?? 0),
        0,
      );

      // Per-line tax aggregation. Hosts attach `tax` (preferred — owns
      // rounding) or `taxRate` (the bridge derives `qty × unitCost ×
      // rate / 100`). Lines with neither contribute zero.
      const taxMajor = items.reduce((s, it) => {
        if (it.tax != null) return s + Number(it.tax);
        const qty = Number(it.quantityReceived ?? it.quantity ?? 0);
        const rate = Number(it.taxRate ?? 0);
        if (rate <= 0 || qty <= 0) return s;
        return s + (qty * Number(it.unitCost ?? 0) * rate) / 100;
      }, 0);

      // Dominant rate for input-VAT account selection (rate-code lookup).
      // Most BD vendor bills are single-rate; if a PO mixes rates, the
      // dominant one wins and the host gets a sane account assignment.
      // Mixed-rate per-line splitting is a future enhancement.
      const dominantTaxRate =
        items.find((it) => Number(it.taxRate ?? 0) > 0)?.taxRate ?? undefined;

      // Vendor bill is INCLUSIVE of tax. A/P credit = net + tax.
      const grossMajor = netMajor + taxMajor;
      if (grossMajor <= 0) {
        logger.warn(
          { orderId: payload.orderId, orderNumber: order.orderNumber },
          '[accounting] flow procurement: zero total, skipping JE',
        );
        return;
      }

      const totalAmountPaisa = Math.round(grossMajor * 100);
      const taxPaisa = Math.round(taxMajor * 100);

      await ensureCompanyAccounts();

      // VDS lookup — non-fatal; if the supplier lookup fails, post without VDS split.
      let withholdVds = false;
      let vdsRate: number | undefined;
      try {
        const supplier = await Supplier.findById(payload.vendorRef).select('withholdVds vdsRate').lean();
        if (supplier?.withholdVds) {
          withholdVds = true;
          vdsRate = supplier.vdsRate ?? 0.5;
        }
      } catch (vdsErr) {
        logger.warn({ err: (vdsErr as Error).message }, '[accounting] VDS supplier lookup failed — posting without VDS split');
      }

      // Procurement-received bridge mirrors purchase-received.handler.ts:
      // the Flow event means "goods are physically in, A/P liability is real
      // and accrued." Skip draft state — there is nothing left to review.
      const posting = vendorBillToPosting(
        {
          purchaseId: String(order._id),
          supplierId: payload.vendorRef,
          totalAmount: totalAmountPaisa,
          tax: taxPaisa,
          ...(dominantTaxRate !== undefined ? { vatRate: dominantTaxRate } : {}),
          receivedAt: new Date(order.receivedAt ?? Date.now()),
          billNumber: order.orderNumber ?? payload.orderNumber,
          withholdVds,
          ...(vdsRate !== undefined ? { vdsRate } : {}),
        },
        { autoPost: true },
      );

      const result = await createPosting(branchId, posting);
      logger.info(
        {
          event: 'flow.procurement.received',
          orderNumber: order.orderNumber,
          journalEntryId: result.journalEntryId,
          totalAmountPaisa,
        },
        '[accounting] flow procurement: vendor bill JE posted',
      );
    } catch (err) {
      logger.error(
        { err: (err as Error).message, orderNumber: payload.orderNumber },
        '[accounting] flow-procurement-received bridge failed',
      );
    }
  });

  logger.info('[accounting] flow-procurement-received bridge registered');
}
