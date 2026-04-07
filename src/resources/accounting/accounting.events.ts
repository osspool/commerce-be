/**
 * Accounting Event Handlers
 *
 * Posting strategy:
 *
 *   SOURCE            TRIGGER                        JOURNAL TYPE      TIMING
 *   ──────────────────────────────────────────────────────────────────────────────
 *   Online order      accounting:order.paid           ECOM_SALES       immediate per-order
 *   POS sale          accounting:day.auto-close        POS_SALES        aggregated per-branch per-day
 *   POS explicit      accounting:pos.day.close         POS_SALES        manual trigger
 *   Purchase          accounting:purchase.paid         PURCHASES        immediate per-purchase
 *   COGS              accounting:order.fulfilled       INVENTORY        immediate per-order
 *   Refund            accounting:transaction.refunded  ECOM_SALES rev.  immediate per-refund
 *   Inventory adj.    accounting:inventory.adjusted    INVENTORY        immediate per-adjustment
 *
 * Day-close triggers:
 *   a) Smart hook: onRequest detects bdDate > lastClosedDate → fires accounting:day.auto-close
 *   b) Explicit: POST /accounting/posting/close-day (manager closes shift)
 *   c) Backfill: POST /accounting/posting/backfill (recovery for missed days)
 */

import mongoose from 'mongoose';
import { subscribe } from '#lib/events/arcEvents.js';
import { withRetry } from '@classytic/arc/events';
import config from '#config/index.js';
import { createPosting, ensureCompanyAccounts } from './posting/posting.service.js';
import { salesTransactionToPosting, type SalesTransactionData } from './posting/contracts/sales.contract.js';
import { purchaseToPosting, type PurchaseData } from './posting/contracts/purchase.contract.js';
import { stockAdjustmentToPosting, cogsToPosting, type StockAdjustmentData, type CogsData } from './posting/contracts/inventory.contract.js';
import { refundToPosting, type RefundData } from './posting/contracts/refund.contract.js';
import { postDailyPosSales } from './posting/aggregation/daily-sales.service.js';
import { tryAcquireCloseLock, getLastClosedDate, markDayClosed, releaseLock } from './posting/day-close-state.service.js';
import Transaction from '#resources/transaction/transaction.model.js';
import { nextBdDate } from '#lib/utils/bd-date.js';
import logger from '#lib/utils/logger.js';

// ─── Register Handlers ──────────────────────────────────────────────────────

export function registerAccountingEventHandlers(): void {
  if (!config.accounting.enabled || config.accounting.mode === 'simple') {
    logger.info({ mode: config.accounting.mode }, 'Accounting auto-posting disabled');
    return;
  }

  // ── 1. Online order payment verified → immediate journal entry ──
  subscribe(
    'accounting:order.paid',
    withRetry(
      async (event: unknown) => {
        const payload = (event as { payload: { transactionId: string } }).payload;

        const txn = (await Transaction.findById(payload.transactionId)
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

        const data: SalesTransactionData = {
          transactionId: txn._id.toString(),
          amount: txn.amount,
          tax: txn.tax || 0,
          method: txn.method,
          date: txn.date || txn.createdAt,
          orderId: txn.sourceId?.toString(),
          source: txn.source,
          branchCode: txn.branchCode,
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

  // ── 2. Smart auto-close → iterate unclosed days and aggregate POS ──
  // Fired by the onRequest hook when it detects lastClosedDate < yesterday.
  // Uses 3-layer deduplication: L1 in-process Set, L2 MongoDB lock, L3 idempotency key.
  subscribe(
    'accounting:day.auto-close',
    withRetry(
      async (event: unknown) => {
        const { branchId, toDate } = (event as { payload: { branchId: string; toDate: string } }).payload;
        if (!branchId || !toDate) return;

        // L2: atomic distributed lock — only one instance closes
        const acquired = await tryAcquireCloseLock(branchId);
        if (!acquired) {
          logger.debug({ branchId }, 'Day-close lock held by another process, skipping');
          return;
        }

        try {
          if (config.accounting.autoSeedAccounts) {
            await ensureCompanyAccounts();
          }

          const lastClosed = await getLastClosedDate(branchId);
          let date = lastClosed ? nextBdDate(lastClosed) : toDate;

          let closedCount = 0;
          while (date <= toDate) {
            const result = await postDailyPosSales(branchId, date);
            if (!result.skipped) closedCount++;
            date = nextBdDate(date);
          }

          await markDayClosed(branchId, toDate);
          if (closedCount > 0) {
            logger.info({ branchId, toDate, closedCount }, 'Auto day-close completed');
          }
        } catch (err) {
          await releaseLock(branchId);
          throw err; // withRetry will handle
        }
      },
      {
        maxRetries: 3,
        backoffMs: 3000,
        name: 'accounting:day.auto-close',
        onDead: (event) => {
          logger.error({ event }, 'accounting:day.auto-close exhausted retries — manual close required');
        },
      },
    ),
  );

  // ── 3. POS day explicitly closed → aggregate and post ──
  subscribe(
    'accounting:pos.day.close',
    withRetry(
      async (event: unknown) => {
        const { branchId, date } = (event as { payload: { branchId: string; date: string } }).payload;
        const result = await postDailyPosSales(branchId, date);
        if (result.skipped) {
          logger.info({ branchId, date, reason: result.reason }, 'POS day-close: nothing to post');
        }
      },
      {
        maxRetries: 3,
        backoffMs: 2000,
        name: 'accounting:pos.day.close',
        onDead: (event) => {
          logger.error({ event }, 'accounting:pos.day.close handler exhausted retries');
        },
      },
    ),
  );

  // ── 4. Purchase paid → immediate journal entry ──
  subscribe(
    'accounting:purchase.paid',
    withRetry(
      async (event: unknown) => {
        const payload = (event as { payload: {
          purchaseId: string;
          amount: number;
          method?: string;
          isPaid?: boolean;
          inventoryType?: string;
          tax?: number;
          branchId?: string;
        } }).payload;

        if (!payload.purchaseId || !payload.amount) return;

        // Resolve branchId from purchase document or event payload
        let orgId = payload.branchId;
        if (!orgId) {
          const purchase = await mongoose.connection.db!.collection('purchases').findOne(
            { _id: new mongoose.Types.ObjectId(payload.purchaseId) },
            { projection: { branch: 1 } },
          );
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
          date: new Date(),
          inventoryType: payload.inventoryType,
          isPaid: payload.isPaid ?? true,
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

  // ── 5. Order fulfilled → COGS journal entry ──
  subscribe(
    'accounting:order.fulfilled',
    withRetry(
      async (event: unknown) => {
        const payload = (event as { payload: { orderId: string } }).payload;
        if (!payload.orderId) return;

        const order = await mongoose.connection.db!.collection('orders').findOne(
          { _id: new mongoose.Types.ObjectId(payload.orderId) },
          { projection: { items: 1, branch: 1, createdAt: 1 } },
        );

        if (!order) {
          logger.warn({ orderId: payload.orderId }, 'Order not found for COGS posting');
          return;
        }

        const orgId = order.branch?.toString();
        if (!orgId) {
          logger.warn({ orderId: payload.orderId }, 'Order has no branch, skipping COGS');
          return;
        }

        // Calculate total cost from items with costPriceAtSale
        const totalCost = (order.items || []).reduce((sum: number, item: any) => {
          const cost = item.costPriceAtSale || 0;
          const qty = item.quantity || 1;
          return sum + (cost * qty);
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

        const txn = (await Transaction.findById(payload.transactionId)
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
        const payload = (event as { payload: {
          adjustmentId: string;
          type: 'loss' | 'gain' | 'correction';
          amount: number;
          date?: string;
          reason?: string;
          branchId?: string;
        } }).payload;

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

  logger.info({ mode: config.accounting.mode }, 'Accounting event handlers registered');
}

export default { registerAccountingEventHandlers };
