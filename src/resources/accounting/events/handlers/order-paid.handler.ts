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

    // Pull promo discount + gateway + customerId + referenceNumber off
    // the order. Without a sourceId we can't look it up — treat as
    // prepaid with no promo and no customer, the historical default for
    // non-order-linked txns.
    const { promoDiscount, orderGateway, customerId, orderReferenceNumber } = orderId
      ? await loadOrderMeta(orderId)
      : { promoDiscount: 0, orderGateway: '', customerId: null, orderReferenceNumber: undefined };

    // Mutual exclusion (single source of truth for credit-sale A/R). When
    // auto-invoicing credit sales is enabled, the @classytic/invoice engine
    // creates AND posts the customer invoice (Dr A/R / Cr Revenue) from this
    // SAME OrderPaid event (it fires only for paymentMethod === 'credit'). The
    // direct sales JE below MUST yield for credit orders, or revenue is
    // recognized twice. Prepaid / COD are unaffected — the invoice engine never
    // creates documents for them, so the direct path stays authoritative there.
    if (config.invoice.autoSales !== 'off' && orderGateway === 'credit') {
      log.debug(
        { orderId },
        'order-paid: auto-invoice owns the credit sale A/R — skipping direct sales JE',
      );
      return null;
    }

    if (orderGateway === 'cod' && orderId) {
      const data: CodPlacementData = {
        transactionId: txn._id.toString(),
        orderId,
        orderReferenceNumber,
        customerId,
        amount: txn.amount,
        tax: txn.tax ?? 0,
        date: txnDate,
        branchCode: txn.branchCode,
        promoDiscount,
      };
      return {
        branchId,
        posting: codPlacementToPosting(data),
        logFields: { transactionId: payload.transactionId, orderId },
        successMessage: 'COD placement journal entry created (A/R posted)',
      };
    }

    // Pull the provider's transaction reference if present. Different gateways
    // store it under different keys; we look at the most common ones in order.
    // Stamping this onto the JE metadata is what lets the settlement matcher
    // do a deterministic 1:1 match instead of falling back to amount+date
    // (which collides on busy days).
    const meta = (txn.metadata ?? {}) as Record<string, unknown>;
    const gatewayTransactionId =
      (meta.gatewayTransactionId as string | undefined) ||
      (meta.providerTxnRef as string | undefined) ||
      (meta.externalTxnRef as string | undefined) ||
      (meta.chargeId as string | undefined) ||
      (meta.trxId as string | undefined) ||
      (meta.paymentReference as string | undefined) ||
      undefined;
    const gatewayProvider =
      (meta.gatewayProvider as string | undefined) ||
      (meta.provider as string | undefined) ||
      undefined;

    const data: SalesTransactionData = {
      transactionId: txn._id.toString(),
      amount: txn.amount,
      tax: txn.tax ?? 0,
      method: txn.method ?? 'unknown',
      date: txnDate,
      orderId,
      orderReferenceNumber,
      source: txn.source ?? 'web',
      branchCode: txn.branchCode,
      promoDiscount,
      ...(gatewayTransactionId ? { gatewayTransactionId } : {}),
      ...(gatewayProvider ? { gatewayProvider } : {}),
    };

    return {
      branchId,
      posting: salesTransactionToPosting(data),
      logFields: { transactionId: payload.transactionId, source: txn.source },
      successMessage: 'Sales journal entry created',
    };
  },
});

async function loadOrderMeta(orderId: string): Promise<{
  promoDiscount: number;
  orderGateway: string;
  customerId: string | null;
  orderReferenceNumber: string | undefined;
}> {
  const empty = { promoDiscount: 0, orderGateway: '', customerId: null, orderReferenceNumber: undefined };
  const _id = mongoose.Types.ObjectId.isValid(orderId) ? new mongoose.Types.ObjectId(orderId) : null;
  if (!_id) return empty;

  const db = mongoose.connection.db;
  if (!db) return empty;

  const order = await db
    .collection('orders')
    .findOne({ _id }, { projection: { metadata: 1, customerId: 1, referenceNumber: 1 } });

  const meta = (order?.metadata as Record<string, unknown> | undefined) ?? {};
  const customerId = (order as { customerId?: unknown } | null)?.customerId;
  const refRaw = (order as { referenceNumber?: unknown } | null)?.referenceNumber;
  return {
    promoDiscount: Number(meta.promoTotalDiscount ?? 0),
    orderGateway: String(meta.paymentGateway ?? '').toLowerCase(),
    customerId: customerId ? String(customerId) : null,
    orderReferenceNumber: refRaw ? String(refRaw) : undefined,
  };
}
