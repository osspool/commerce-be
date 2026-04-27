/**
 * Accounting Event Handlers
 *
 * Posting strategy:
 *
 *   SOURCE            TRIGGER                        JOURNAL TYPE      TIMING
 *   ──────────────────────────────────────────────────────────────────────────────
 *   Online order      accounting:order.paid           ECOM_SALES       immediate per-order
 *   POS sale          (shift-close, via @classytic/pos LedgerBridge)   POS_SALES   per-shift
 *   Purchase          accounting:purchase.paid         PURCHASES        immediate per-purchase
 *   COGS              accounting:order.fulfilled       INVENTORY        immediate per-order
 *   Refund            accounting:transaction.refunded  ECOM_SALES rev.  immediate per-refund
 *   Inventory adj.    accounting:inventory.adjusted    INVENTORY        immediate per-adjustment
 *
 * POS posting is shift-driven (industry standard — Odoo, Square, Lightspeed,
 * Dynamics 365 Retail all converge on session/shift as the unit of close).
 * The legacy date-aggregator (`accounting:day.auto-close` / `pos.day.close`)
 * was deleted along with `daily-sales.service.ts`. See the package's
 * `LedgerBridge.onShiftClosed` — implemented in
 * `posting/contracts/shift.contract.ts`.
 */

import { withRetry } from '@classytic/arc/events';
import mongoose from 'mongoose';
import config from '#config/index.js';
import { subscribe } from '#lib/events/arcEvents.js';
import logger from '#lib/utils/logger.js';
import { getTransactionModel } from '#shared/revenue/engine.js';
import { type CodCancellationData, codCancellationToPosting } from './posting/contracts/cod-cancellation.contract.js';
import { type CodPlacementData, codPlacementToPosting } from './posting/contracts/cod-placement.contract.js';
import { type CodSettlementData, codSettlementToPosting } from './posting/contracts/cod-settlement.contract.js';
import {
  type CogsData,
  type CogsReversalData,
  cogsReversalToPosting,
  cogsToPosting,
  type StockAdjustmentData,
  stockAdjustmentToPosting,
} from './posting/contracts/inventory.contract.js';
import { type PurchaseData, purchaseToPosting } from './posting/contracts/purchase.contract.js';
import { type RefundData, refundToPosting } from './posting/contracts/refund.contract.js';
import { type SalesTransactionData, salesTransactionToPosting } from './posting/contracts/sales.contract.js';
import { vendorBillToPosting } from './posting/contracts/vendor-bill.contract.js';
import { createPosting, ensureCompanyAccounts } from './posting/posting.service.js';

// ─── Register Handlers ──────────────────────────────────────────────────────

// Module-level idempotency guard. `registerAccountingEventHandlers()` is
// called from three independent bootstrap paths (accounting.plugin.ts,
// cron/index.ts, core/factories/background-runtime.ts) to keep each
// entry point self-contained — the event bus is a memory transport that
// deduplicates by handler identity NOT by pattern, so each call installs
// a fresh set of `withRetry(…)` closures. That produced 3× handler fan
// out for every event (visible in logs as "Purchase journal entry created"
// firing three times per operation). This flag makes the function
// idempotent. Mirrors the identical pattern in
// #resources/notifications/notification.handlers.ts.
let handlersRegistered = false;

export function registerAccountingEventHandlers(): void {
  if (!config.accounting.enabled || config.accounting.mode === 'simple') {
    logger.info({ mode: config.accounting.mode }, 'Accounting auto-posting disabled');
    return;
  }

  if (handlersRegistered) {
    logger.debug('Accounting event handlers already registered — skipping');
    return;
  }
  handlersRegistered = true;

  // ── 1. Online order payment verified → immediate journal entry ──
  subscribe(
    'accounting:order.paid',
    withRetry(
      async (event: unknown) => {
        const payload = (event as { payload: { transactionId: string } }).payload;

        const txn = (await getTransactionModel()
          .findById(payload.transactionId)
          .select('_id amount tax method date source branch branchCode sourceId flow status metadata')
          .lean()) as any;

        if (!txn || txn.flow !== 'inflow' || txn.status !== 'verified') return;

        // POS transactions are handled via day-close, not per-transaction
        const isPosSource = txn.source === 'pos' || (txn.metadata as any)?.source === 'pos';
        if (isPosSource) return;
        if (!txn.branch) {
          logger.warn({ transactionId: payload.transactionId }, 'Transaction has no branch, skipping accounting');
          return;
        }

        const orgId = txn.branch.toString();
        if (config.accounting.autoSeedAccounts) {
          await ensureCompanyAccounts();
        }

        // Pull promo discount and payment gateway off the order. Gateway
        // decides which posting contract to use: COD posts A/R (1141) and
        // reclassifies on settlement; prepaid posts Cash/Bank directly.
        //
        // The @classytic/order schema does NOT persist a raw `payment` field
        // (only the `paymentState` FSM subdoc) — placement.service.ts stamps
        // `metadata.paymentGateway` so we have a stable handle here.
        let promoDiscount = 0;
        let orderGateway = '';
        if (txn.sourceId) {
          const order = await mongoose.connection
            .db!.collection('orders')
            .findOne(
              {
                _id:
                  txn.sourceId instanceof mongoose.Types.ObjectId
                    ? txn.sourceId
                    : new mongoose.Types.ObjectId(txn.sourceId.toString()),
              },
              { projection: { metadata: 1 } },
            );
          const meta = (order?.metadata as Record<string, unknown> | undefined) ?? {};
          promoDiscount = Number(meta.promoTotalDiscount ?? 0);
          orderGateway = String(meta.paymentGateway ?? '').toLowerCase();
        }

        const txnDate = txn.date || (txn as any).createdAt || new Date();
        const orderId = txn.sourceId?.toString();

        // COD path — post to A/R, NOT to cash. The money isn't in hand yet;
        // the courier will collect and remit (minus commission) later. The
        // /orders/:id/cod-settlement endpoint reclassifies A/R → Bank
        // when the admin records the actual received amount.
        if (orderGateway === 'cod' && orderId) {
          const codData: CodPlacementData = {
            transactionId: txn._id.toString(),
            orderId,
            amount: txn.amount,
            tax: txn.tax || 0,
            date: txnDate,
            branchCode: txn.branchCode,
            promoDiscount,
          };
          const posting = codPlacementToPosting(codData, { autoPost: config.accounting.autoPost });
          const result = await createPosting(orgId, posting);
          logger.info(
            { transactionId: payload.transactionId, journalEntryId: result.journalEntryId, orderId },
            'COD placement journal entry created (A/R posted)',
          );
          return;
        }

        const data: SalesTransactionData = {
          transactionId: txn._id.toString(),
          amount: txn.amount,
          tax: txn.tax || 0,
          method: txn.method,
          date: txnDate,
          orderId,
          source: txn.source,
          branchCode: txn.branchCode,
          promoDiscount,
        };

        const posting = salesTransactionToPosting(data, { autoPost: config.accounting.autoPost });
        const result = await createPosting(orgId, posting);

        logger.info(
          { transactionId: payload.transactionId, journalEntryId: result.journalEntryId, source: txn.source },
          'Sales journal entry created',
        );
      },
      {
        maxRetries: 3,
        backoffMs: 2000,
        name: 'accounting:order.paid',
        onDead: (event) => {
          logger.error({ event }, 'accounting:order.paid handler exhausted retries');
        },
      },
    ),
  );

  // POS day-close subscribers were removed — POS posting is now driven
  // by the @classytic/pos LedgerBridge at shift close. The previous
  // `accounting:day.auto-close` and `accounting:pos.day.close` handlers
  // duplicated that posting via the date-based aggregator.

  // ── 4. Purchase paid → immediate journal entry ──
  subscribe(
    'accounting:purchase.paid',
    withRetry(
      async (event: unknown) => {
        const payload = (
          event as {
            payload: {
              purchaseId: string;
              amount: number;
              method?: string;
              isPaid?: boolean;
              inventoryType?: string;
              tax?: number;
              vatRate?: number;
              branchId?: string;
              currency?: string;
              exchangeRate?: number;
              foreignTotal?: number;
            };
          }
        ).payload;

        if (!payload.purchaseId || !payload.amount) return;

        // Resolve branchId from purchase document or event payload
        let orgId = payload.branchId;
        if (!orgId) {
          const purchase = await mongoose.connection
            .db!.collection('purchase_orders')
            .findOne({ _id: new mongoose.Types.ObjectId(payload.purchaseId) }, { projection: { branch: 1 } });
          orgId = purchase?.branch?.toString();
        }

        if (!orgId) {
          logger.warn({ purchaseId: payload.purchaseId }, 'Purchase has no branch, skipping accounting');
          return;
        }

        if (config.accounting.autoSeedAccounts) {
          await ensureCompanyAccounts();
        }

        const data: PurchaseData = {
          purchaseId: payload.purchaseId,
          supplierId: '', // Not needed for posting
          totalAmount: payload.amount,
          tax: payload.tax || 0,
          vatRate: payload.vatRate,
          date: new Date(),
          inventoryType: payload.inventoryType,
          isPaid: payload.isPaid ?? true,
          currency: payload.currency,
          exchangeRate: payload.exchangeRate,
          foreignTotal: payload.foreignTotal,
        };

        const posting = purchaseToPosting(data, { autoPost: config.accounting.autoPost });
        const result = await createPosting(orgId, posting);

        logger.info(
          { purchaseId: payload.purchaseId, journalEntryId: result.journalEntryId },
          'Purchase journal entry created',
        );
      },
      {
        maxRetries: 3,
        backoffMs: 2000,
        name: 'accounting:purchase.paid',
        onDead: (event) => {
          logger.error({ event }, 'accounting:purchase.paid handler exhausted retries');
        },
      },
    ),
  );

  // ── 4b. Purchase received → accrual vendor bill (Phase 1 A/P) ──
  // Accrual-correct: bill lands on 2111 tagged with partnerId at RECEIPT,
  // not at payment. Payment is a second JE matched to the bill line via
  // reconciliations.match() — see /accounting/vendor-bills/:billJeId/pay.
  subscribe(
    'purchase:received',
    withRetry(
      async (event: unknown) => {
        const payload = (event as { payload: { purchaseId: string; organizationId?: string } }).payload;
        if (!payload.purchaseId) return;
        const purchase = await mongoose.connection
          .db!.collection('purchase_orders')
          .findOne({ _id: new mongoose.Types.ObjectId(payload.purchaseId) });
        if (!purchase || !purchase.supplier) return;

        if (config.accounting.autoSeedAccounts) {
          await ensureCompanyAccounts();
        }

        // Extract tax from purchase document. Prefer explicit taxTotal; fall
        // back to per-item taxAmount summation for legacy docs.
        const items = (purchase.items as Array<Record<string, unknown>>) ?? [];
        const taxFromItems = items.reduce((s, it) => s + Number(it.taxAmount ?? 0), 0);
        const tax = Number(purchase.taxTotal ?? taxFromItems ?? 0);
        // Infer a dominant rate code from items for account selection.
        // When items have mixed rates this picks the most common; per-line
        // splitting is a future enhancement.
        const firstTaxedRate = items.find((it) => Number(it.taxRate ?? 0) > 0)?.taxRate as number | undefined;

        const posting = vendorBillToPosting({
          purchaseId: String(purchase._id),
          supplierId: String(purchase.supplier),
          totalAmount: Number(purchase.grandTotal || 0),
          tax,
          vatRate: firstTaxedRate,
          receivedAt: new Date((purchase.receivedAt as Date) || new Date()),
          dueDate: purchase.dueDate ? new Date(purchase.dueDate as Date) : undefined,
          creditDays: purchase.creditDays as number | undefined,
          billNumber: purchase.invoiceNumber as string | undefined,
        });
        const branchId = (purchase.branch && String(purchase.branch)) || payload.organizationId || undefined;
        const result = await createPosting(branchId, posting);
        logger.info(
          { purchaseId: payload.purchaseId, journalEntryId: result.journalEntryId },
          'Vendor bill posted (accrual A/P)',
        );
      },
      {
        maxRetries: 3,
        backoffMs: 2000,
        name: 'purchase:received:accounting',
        onDead: (event) => {
          logger.error({ event }, 'purchase:received accounting handler exhausted retries');
        },
      },
    ),
  );

  // ── 5. Order fulfilled → COGS journal entry ──
  subscribe(
    'accounting:order.fulfilled',
    withRetry(
      async (event: unknown) => {
        const payload = (event as { payload: { orderId: string } }).payload;
        if (!payload.orderId) return;

        const order = await mongoose.connection
          .db!.collection('orders')
          .findOne(
            { _id: new mongoose.Types.ObjectId(payload.orderId) },
            { projection: { lines: 1, items: 1, branch: 1, organizationId: 1, createdAt: 1 } },
          );

        if (!order) {
          logger.warn({ orderId: payload.orderId }, 'Order not found for COGS posting');
          return;
        }

        const orgId = order.organizationId?.toString() ?? order.branch?.toString();
        if (!orgId) {
          logger.warn({ orderId: payload.orderId }, 'Order has no branch/org, skipping COGS');
          return;
        }

        // @classytic/order stores lines with snapshot.costPrice.
        // Legacy orders may use items[].costPriceAtSale. Support both.
        const lines = order.lines as Array<{ snapshot?: { costPrice?: number }; quantity?: number }> | undefined;
        const items = order.items as Array<{ costPriceAtSale?: number; quantity?: number }> | undefined;

        const totalCost =
          (lines || []).reduce((sum: number, line: any) => {
            const cost = line.snapshot?.costPrice ?? 0;
            const qty = line.quantity ?? 1;
            return sum + cost * qty;
          }, 0) ||
          (items || []).reduce((sum: number, item: any) => {
            const cost = item.costPriceAtSale ?? 0;
            const qty = item.quantity ?? 1;
            return sum + cost * qty;
          }, 0);

        if (totalCost <= 0) {
          logger.debug({ orderId: payload.orderId }, 'Order has no cost data, skipping COGS');
          return;
        }

        if (config.accounting.autoSeedAccounts) {
          await ensureCompanyAccounts();
        }

        const data: CogsData = {
          orderId: payload.orderId,
          costAmount: totalCost,
          date: order.createdAt || new Date(),
        };

        const posting = cogsToPosting(data, { autoPost: config.accounting.autoPost });
        const result = await createPosting(orgId, posting);

        logger.info(
          { orderId: payload.orderId, journalEntryId: result.journalEntryId, totalCost },
          'COGS journal entry created',
        );
      },
      {
        maxRetries: 3,
        backoffMs: 2000,
        name: 'accounting:order.fulfilled',
        onDead: (event) => {
          logger.error({ event }, 'accounting:order.fulfilled handler exhausted retries');
        },
      },
    ),
  );

  // ── 6. Transaction refunded → reversal journal entry ──
  subscribe(
    'accounting:transaction.refunded',
    withRetry(
      async (event: unknown) => {
        const payload = (event as { payload: { transactionId: string; refundAmount?: number } }).payload;
        if (!payload.transactionId) return;

        const txn = (await getTransactionModel()
          .findById(payload.transactionId)
          .select('_id amount tax method date source branch branchCode sourceId flow status')
          .lean()) as any;

        if (!txn) {
          logger.warn({ transactionId: payload.transactionId }, 'Refund transaction not found');
          return;
        }

        if (!txn.branch) {
          logger.warn({ transactionId: payload.transactionId }, 'Refund transaction has no branch, skipping');
          return;
        }

        const orgId = txn.branch.toString();
        if (config.accounting.autoSeedAccounts) {
          await ensureCompanyAccounts();
        }

        const data: RefundData = {
          transactionId: txn._id.toString(),
          refundAmount: payload.refundAmount || txn.amount,
          tax: txn.tax || 0,
          method: txn.method,
          date: txn.date || new Date(),
          orderId: txn.sourceId?.toString(),
        };

        const posting = refundToPosting(data, { autoPost: config.accounting.autoPost });
        const result = await createPosting(orgId, posting);

        logger.info(
          { transactionId: payload.transactionId, journalEntryId: result.journalEntryId },
          'Refund reversal journal entry created',
        );
      },
      {
        maxRetries: 3,
        backoffMs: 2000,
        name: 'accounting:transaction.refunded',
        onDead: (event) => {
          logger.error({ event }, 'accounting:transaction.refunded handler exhausted retries');
        },
      },
    ),
  );

  // ── 7. Inventory adjustment → journal entry ──
  subscribe(
    'accounting:inventory.adjusted',
    withRetry(
      async (event: unknown) => {
        const payload = (
          event as {
            payload: {
              adjustmentId: string;
              type: 'loss' | 'gain' | 'correction';
              amount: number;
              date?: string;
              reason?: string;
              branchId?: string;
            };
          }
        ).payload;

        if (!payload.adjustmentId || !payload.amount) return;

        const orgId = payload.branchId;
        if (!orgId) {
          logger.warn({ adjustmentId: payload.adjustmentId }, 'Adjustment has no branchId, skipping accounting');
          return;
        }

        if (config.accounting.autoSeedAccounts) {
          await ensureCompanyAccounts();
        }

        const data: StockAdjustmentData = {
          adjustmentId: payload.adjustmentId,
          type: payload.type,
          amount: payload.amount,
          date: payload.date ? new Date(payload.date) : new Date(),
          reason: payload.reason,
        };

        const posting = stockAdjustmentToPosting(data, { autoPost: config.accounting.autoPost });
        const result = await createPosting(orgId, posting);

        logger.info(
          { adjustmentId: payload.adjustmentId, journalEntryId: result.journalEntryId, type: payload.type },
          'Inventory adjustment journal entry created',
        );
      },
      {
        maxRetries: 3,
        backoffMs: 2000,
        name: 'accounting:inventory.adjusted',
        onDead: (event) => {
          logger.error({ event }, 'accounting:inventory.adjusted handler exhausted retries');
        },
      },
    ),
  );

  // ── 7b. Return restock → COGS reversal journal ──
  //
  // Fires from return.service.processRefund when restockable items go back
  // into inventory via Flow MoveGroups. The stock side already moved (Flow
  // owns that), so this handler only posts the accounting reversal:
  //
  //   Dr 1165 Inventory | Cr 5111 COGS   — for (costPrice × qty) of restocked items
  //
  // `costAmount` in the payload is the partial amount — only items whose
  // inspectionResult is APPROVED or PARTIAL count. Rejected items are NOT
  // restocked (they're scrapped or returned to vendor through a separate
  // flow), so their cost stays in COGS.
  //
  // Idempotency: `cogs-reversal-${returnId}` on the posting. Re-emitting
  // for the same return is a no-op — posting.service dedupes by key.
  subscribe(
    'accounting:return.restocked',
    withRetry(
      async (event: unknown) => {
        const payload = (
          event as {
            payload: {
              returnId: string;
              orderId: string;
              costAmount: number;
              branchId: string;
              date?: string;
              description?: string;
            };
          }
        ).payload;

        if (!payload.returnId || !payload.orderId) return;
        if (!payload.branchId) {
          logger.warn({ returnId: payload.returnId }, 'return.restocked missing branchId — skipping');
          return;
        }
        if (!payload.costAmount || payload.costAmount <= 0) {
          // Zero-cost returns (services, promo items) have nothing to reverse
          // on the ledger side — stock may still have moved but there's no
          // COGS to undo. Safe to skip silently.
          logger.debug({ returnId: payload.returnId }, 'return.restocked: zero costAmount, skipping');
          return;
        }

        if (config.accounting.autoSeedAccounts) {
          await ensureCompanyAccounts();
        }

        const data: CogsReversalData = {
          returnId: payload.returnId,
          orderId: payload.orderId,
          costAmount: payload.costAmount,
          date: payload.date ? new Date(payload.date) : new Date(),
          description: payload.description,
        };

        const posting = cogsReversalToPosting(data, { autoPost: config.accounting.autoPost });
        const result = await createPosting(payload.branchId, posting);

        logger.info(
          {
            returnId: payload.returnId,
            orderId: payload.orderId,
            journalEntryId: result.journalEntryId,
            costAmount: payload.costAmount,
          },
          'COGS reversal journal entry created (Dr Inventory | Cr COGS)',
        );
      },
      {
        maxRetries: 3,
        backoffMs: 2000,
        name: 'accounting:return.restocked',
        onDead: (event) => {
          logger.error({ event }, 'accounting:return.restocked handler exhausted retries');
        },
      },
    ),
  );

  // ── 8. Bridge: order:fulfilled → accounting:order.fulfilled ──
  //
  // @classytic/order emits `order:fulfilled` when all line items are
  // allocated to fulfillments. This bridge publishes the accounting event
  // that triggers the COGS journal entry (handler #5 above).
  subscribe(
    'order:fulfilled',
    withRetry(
      async (event: unknown) => {
        const payload = (event as { payload: { orderId?: string; orderNumber?: string; organizationId?: string } })
          .payload;
        const orderId = payload.orderId;
        if (!orderId) {
          logger.warn({ payload }, 'order:fulfilled missing orderId, skipping COGS bridge');
          return;
        }

        logger.info({ orderId }, 'Bridging order:fulfilled → accounting:order.fulfilled');

        // Re-publish as accounting event — handler #5 picks it up
        const { publish: publishEvent } = await import('#lib/events/arcEvents.js');
        await publishEvent('accounting:order.fulfilled', { orderId });
      },
      {
        maxRetries: 3,
        backoffMs: 2000,
        name: 'order:fulfilled:accounting-bridge',
        onDead: (event) => {
          logger.error({ event }, 'order:fulfilled accounting bridge exhausted retries');
        },
      },
    ),
  );

  // ── 9. COD settlement recorded → reclassify A/R to Bank + Commission + Writeoff ──
  //
  // Fired by POST /orders/:id/cod-settlement after the admin enters the
  // actual amount remitted by the courier. The route has already validated
  // the balance invariant (actualReceived + commission + writeoff == gross)
  // and persisted the settlement record on order.metadata.codSettlement.
  //
  // Posts a second journal entry that clears the A/R posted at placement
  // and debits Bank + Courier Commission (+ optional Writeoff). Together
  // with the placement entry, the net trial-balance impact is:
  //   Dr Bank (what we got) + Dr Commission (what courier kept) + Dr Writeoff
  //   Cr Revenue (full) + Cr VAT
  subscribe(
    'accounting:cod.settled',
    withRetry(
      async (event: unknown) => {
        const payload = (
          event as {
            payload: {
              settlementId: string;
              orderId: string;
              grossAmount: number;
              actualReceived: number;
              courierCommission: number;
              writeoff: number;
              cashAccount?: string;
              notes?: string;
              date?: string;
              branchId: string;
            };
          }
        ).payload;

        if (!payload.orderId || !payload.settlementId) return;
        if (!payload.branchId) {
          logger.warn({ settlementId: payload.settlementId }, 'COD settlement missing branchId — skipping');
          return;
        }

        if (config.accounting.autoSeedAccounts) {
          await ensureCompanyAccounts();
        }

        const data: CodSettlementData = {
          settlementId: payload.settlementId,
          orderId: payload.orderId,
          grossAmount: payload.grossAmount,
          actualReceived: payload.actualReceived,
          courierCommission: payload.courierCommission,
          writeoff: payload.writeoff,
          cashAccount: payload.cashAccount,
          date: payload.date ? new Date(payload.date) : new Date(),
          notes: payload.notes,
        };

        const posting = codSettlementToPosting(data, { autoPost: config.accounting.autoPost });
        const result = await createPosting(payload.branchId, posting);

        logger.info(
          {
            orderId: payload.orderId,
            settlementId: payload.settlementId,
            journalEntryId: result.journalEntryId,
            actualReceived: payload.actualReceived,
            courierCommission: payload.courierCommission,
            writeoff: payload.writeoff,
          },
          'COD settlement journal entry created (A/R cleared → Bank + Commission + Writeoff)',
        );
      },
      {
        maxRetries: 3,
        backoffMs: 2000,
        name: 'accounting:cod.settled',
        onDead: (event) => {
          logger.error({ event }, 'accounting:cod.settled handler exhausted retries');
        },
      },
    ),
  );

  // ── 10. COD cancellation → reverse A/R placement ──
  //
  // Fired by POST /orders/:id/action { action: 'cancel' } when the order
  // was COD AND a settlement was NOT already recorded. Posts a contra-entry
  // that reverses the placement journal (Cr A/R, Dr Revenue reversal).
  // Orders that WERE settled should use /refund instead — the money is
  // already in the bank and needs a cash-out entry, not an A/R clearance.
  subscribe(
    'accounting:cod.cancelled',
    withRetry(
      async (event: unknown) => {
        const payload = (
          event as {
            payload: {
              orderId: string;
              grossAmount: number;
              tax: number;
              promoDiscount?: number;
              reason?: string;
              date?: string;
              branchId: string;
            };
          }
        ).payload;

        if (!payload.orderId || !payload.branchId) return;
        if (payload.grossAmount <= 0) return;

        if (config.accounting.autoSeedAccounts) {
          await ensureCompanyAccounts();
        }

        const data: CodCancellationData = {
          orderId: payload.orderId,
          grossAmount: payload.grossAmount,
          tax: payload.tax,
          promoDiscount: payload.promoDiscount,
          date: payload.date ? new Date(payload.date) : new Date(),
          reason: payload.reason,
        };

        const posting = codCancellationToPosting(data, { autoPost: config.accounting.autoPost });
        const result = await createPosting(payload.branchId, posting);

        logger.info(
          { orderId: payload.orderId, journalEntryId: result.journalEntryId, reason: payload.reason },
          'COD cancellation journal entry created (A/R reversed)',
        );
      },
      {
        maxRetries: 3,
        backoffMs: 2000,
        name: 'accounting:cod.cancelled',
        onDead: (event) => {
          logger.error({ event }, 'accounting:cod.cancelled handler exhausted retries');
        },
      },
    ),
  );

  logger.info({ mode: config.accounting.mode }, 'Accounting event handlers registered');
}

export default { registerAccountingEventHandlers };
