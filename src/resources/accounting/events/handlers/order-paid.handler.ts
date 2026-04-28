import mongoose from 'mongoose';
import config from '#config/index.js';
import { getTransactionModel } from '#shared/revenue/engine.js';
import { type CodPlacementData, codPlacementToPosting } from '../../posting/contracts/cod-placement.contract.js';
import { type SalesTransactionData, salesTransactionToPosting } from '../../posting/contracts/sales.contract.js';
import { definePostingHandler, type PostingWork } from '../define-posting-handler.js';
import { OrderPaidEvent, orderPaidSchema } from '../event-definitions.js';

interface TxnDoc {
  _id: { toString(): string };
  amount: number;
  tax?: number;
  method?: string;
  date?: Date;
  source?: string;
  branch?: { toString(): string };
  branchCode?: string;
  sourceId?: { toString(): string } | mongoose.Types.ObjectId;
  flow?: string;
  status?: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

/**
 * Online order payment verified → immediate journal entry.
 *
 * Branches on payment gateway:
 *   - **COD**: posts A/R (1141) at placement; reclassified to Bank +
 *     Commission (+ Writeoff) on settlement (`cod-settled.handler.ts`).
 *   - **Prepaid**: posts Cash/Bank directly via `salesTransactionToPosting`.
 *
 * POS transactions are skipped — they're posted via the
 * `@classytic/pos` `LedgerBridge` at shift close, not per-transaction.
 *
 * Promo discount + payment gateway are read off the order document.
 * `@classytic/order` does not persist a raw `payment` field (only the
 * `paymentState` FSM subdoc), so `placement.service.ts` stamps
 * `metadata.paymentGateway` for stable lookup here.
 */
export const orderPaidHandler = definePostingHandler({
  event: OrderPaidEvent,
  payloadSchema: orderPaidSchema,

  async build(payload, log): Promise<PostingWork | null> {
    const txn = (await getTransactionModel()
      .findById(payload.transactionId)
      .select('_id amount tax method date source branch branchCode sourceId flow status metadata')
      .lean()) as TxnDoc | null;

    if (!txn) return null;
    if (txn.flow !== 'inflow' || txn.status !== 'verified') return null;

    // POS transactions are posted via @classytic/pos LedgerBridge at
    // shift close — this per-transaction handler must not double-post.
    const isPosSource = txn.source === 'pos' || (txn.metadata as { source?: string } | undefined)?.source === 'pos';
    if (isPosSource) return null;

    if (!txn.branch) {
      log.warn({ transactionId: payload.transactionId }, 'Transaction has no branch, skipping accounting');
      return null;
    }

    const branchId = txn.branch.toString();
    const orderId = txn.sourceId?.toString();
    const txnDate = txn.date ?? txn.createdAt ?? new Date();

    // Pull promo discount + gateway off the order. Without a sourceId
    // we can't look it up — treat as prepaid with no promo, which is
    // the historical default for non-order-linked transactions.
    const { promoDiscount, orderGateway } = orderId
      ? await loadOrderMeta(orderId)
      : { promoDiscount: 0, orderGateway: '' };

    if (orderGateway === 'cod' && orderId) {
      const data: CodPlacementData = {
        transactionId: txn._id.toString(),
        orderId,
        amount: txn.amount,
        tax: txn.tax ?? 0,
        date: txnDate,
        branchCode: txn.branchCode,
        promoDiscount,
      };
      return {
        branchId,
        posting: codPlacementToPosting(data, { autoPost: config.accounting.autoPost }),
        logFields: { transactionId: payload.transactionId, orderId },
        successMessage: 'COD placement journal entry created (A/R posted)',
      };
    }

    const data: SalesTransactionData = {
      transactionId: txn._id.toString(),
      amount: txn.amount,
      tax: txn.tax ?? 0,
      method: txn.method ?? 'unknown',
      date: txnDate,
      orderId,
      source: txn.source ?? 'web',
      branchCode: txn.branchCode,
      promoDiscount,
    };

    return {
      branchId,
      posting: salesTransactionToPosting(data, { autoPost: config.accounting.autoPost }),
      logFields: { transactionId: payload.transactionId, source: txn.source },
      successMessage: 'Sales journal entry created',
    };
  },
});

async function loadOrderMeta(orderId: string): Promise<{ promoDiscount: number; orderGateway: string }> {
  const _id = mongoose.Types.ObjectId.isValid(orderId) ? new mongoose.Types.ObjectId(orderId) : null;
  if (!_id) return { promoDiscount: 0, orderGateway: '' };

  const db = mongoose.connection.db;
  if (!db) return { promoDiscount: 0, orderGateway: '' };

  const order = await db.collection('orders').findOne({ _id }, { projection: { metadata: 1 } });

  const meta = (order?.metadata as Record<string, unknown> | undefined) ?? {};
  return {
    promoDiscount: Number(meta.promoTotalDiscount ?? 0),
    orderGateway: String(meta.paymentGateway ?? '').toLowerCase(),
  };
}
