/**
 * RevenueBridge implementation — wires @classytic/order to @classytic/revenue.
 *
 * Provides the payment lifecycle operations the order package defines as a
 * port. The bridge delegates to the revenue engine's `transaction` repository
 * domain verbs (`createPaymentIntent`, `verify`, `refund`, `hold`, `release`)
 * so provider routing, commission calculation, and state-machine guards all
 * happen inside revenue, not here.
 *
 * Provider routing is by `gateway` name:
 *   - 'manual' | 'cash' | 'bank_transfer'  → ManualProvider (immediate verify)
 *   - 'bkash' | 'sslcommerz' | 'stripe'    → the provider registered at that key
 *
 * Adding a new provider is three steps, none of which touch this file:
 *   1. `npm i @classytic/revenue-<name>` (or write one extending PaymentProvider)
 *   2. register it on the engine: `providers: { bkash: new BkashProvider(...) }`
 *   3. accept the new gateway string in FE `PaymentMethods` + place handler
 */
import type {
  BridgeRef,
  BridgeStatus,
  Money,
  OrderContext,
  PaymentIntentResult,
  PaymentVerificationResult,
  RefundResult,
  RevenueBridge,
} from '@classytic/order';
import type { RevenueContext } from '@classytic/revenue';
import { TRANSACTION_STATUS } from '@classytic/revenue/enums';
import { getRevenueEngine, isRevenueReady } from '#shared/revenue/engine.js';

type TxnDoc = {
  _id: { toString(): string };
  publicId?: string;
  status: string;
  amount: number;
  currency: string;
  method?: string;
  gateway?: { type?: string; sessionId?: string; paymentIntentId?: string; metadata?: Record<string, unknown> };
  verifiedAt?: Date;
};

function toRevenueCtx(ctx: OrderContext): RevenueContext {
  return {
    organizationId: ctx.organizationId,
    actorId: ctx.actorRef,
    traceId: ctx.correlationId,
  };
}

function mapVerifyStatus(status: string): PaymentVerificationResult['status'] {
  if (status === TRANSACTION_STATUS.VERIFIED) return 'verified';
  if (status === TRANSACTION_STATUS.FAILED) return 'failed';
  if (status === TRANSACTION_STATUS.REQUIRES_ACTION) return 'requires_action';
  return 'processing';
}

function mapIntentStatus(status: string): PaymentIntentResult['status'] {
  if (status === TRANSACTION_STATUS.VERIFIED) return 'succeeded';
  if (status === TRANSACTION_STATUS.REQUIRES_ACTION) return 'requires_action';
  if (status === TRANSACTION_STATUS.PROCESSING) return 'processing';
  return 'pending';
}

function mapTxnToBridgeStatus(status: string): BridgeStatus {
  switch (status) {
    case TRANSACTION_STATUS.VERIFIED:
      return 'committed';
    case TRANSACTION_STATUS.FAILED:
    case TRANSACTION_STATUS.REFUNDED:
    case TRANSACTION_STATUS.PARTIALLY_REFUNDED:
      return 'canceled';
    case TRANSACTION_STATUS.PENDING:
    case TRANSACTION_STATUS.PROCESSING:
    case TRANSACTION_STATUS.REQUIRES_ACTION:
      return 'pending';
    default:
      return 'unknown';
  }
}

/**
 * Stamp the be-prod-specific extra fields on a freshly-created revenue
 * transaction. The accounting handler keys off `branch` to pick the right
 * tenant; without it the handler logs `Transaction has no branch, skipping
 * accounting` and the journal entry is never created. We use mongoose
 * directly because the revenue engine has `multiTenant: false` — there's
 * no schema-level coercion to do this for us.
 */
async function stampAccountingFields(
  repo: unknown,
  txnId: { toString(): string },
  organizationId: string,
): Promise<void> {
  try {
    const model = (repo as { Model: { updateOne: Function } }).Model;
    await model.updateOne({ _id: txnId }, { $set: { branch: organizationId, source: 'web' } });
  } catch {
    // Best-effort. The revenue side is already complete; the accounting
    // bridge will simply skip and log a warning.
  }
}

function amountOf(money: Money | { amount: number; currency: string }): number {
  return typeof (money as { amount?: number }).amount === 'number' ? (money as { amount: number }).amount : 0;
}

function currencyOf(money: Money | { amount: number; currency: string }): string {
  return (money as { currency?: string }).currency ?? 'BDT';
}

export function createRevenueBridge(): RevenueBridge {
  return {
    /**
     * Deferred payment — creates a PENDING transaction and calls the provider
     * to mint a session/intent. Use for web checkout (Stripe, SSLCommerz,
     * bKash redirect flow). The returned `paymentUrl` / `clientSecret` is
     * what the FE uses to complete payment.
     */
    async createPaymentIntent(params): Promise<PaymentIntentResult> {
      const engine = getRevenueEngine();
      const repo = engine.repositories.transaction;
      const txn = (await repo.createPaymentIntent(
        {
          amount: amountOf(params.amount),
          currency: currencyOf(params.amount),
          gateway: params.gateway,
          paymentData: params.metadata,
          metadata: {
            ...(params.metadata ?? {}),
            orderId: params.orderId,
            lineItems: params.lineItems,
          },
          idempotencyKey: params.idempotencyKey,
          data: {
            sourceId: params.orderId,
            sourceModel: 'Order',
            customerId: params.customerId,
          },
        },
        toRevenueCtx({
          organizationId: params.organizationId,
          actorRef: params.customerId,
          actorKind: 'user',
          correlationId: params.idempotencyKey,
        } as OrderContext),
      )) as TxnDoc;

      // Stamp be-prod's accounting-required extra fields. Revenue's
      // `createPaymentIntent` doesn't know about them (they're host
      // schema extensions), but the accounting handler refuses to post
      // anything without `branch` set. Single-tenant: branch === org.
      await stampAccountingFields(repo, txn._id, params.organizationId);

      return {
        transactionId: txn._id.toString(),
        intentId: txn.gateway?.paymentIntentId ?? txn.gateway?.sessionId,
        status: mapIntentStatus(txn.status),
        amount: txn.amount,
        currency: txn.currency,
        paymentUrl: txn.gateway?.metadata?.paymentUrl as string | undefined,
        clientSecret: txn.gateway?.metadata?.clientSecret as string | undefined,
      };
    },

    /**
     * Immediate verification — POS / cash / manual MFS TrxID entry.
     *
     * Done as intent → verify (not a single insert) so that:
     *   1. idempotencyKey dedup is handled by `createPaymentIntent` internally,
     *   2. state-machine guards fire (PENDING → VERIFIED is legal; any other
     *      path throws and surfaces the real bug),
     *   3. the `after:update` hook in revenue.plugin observes the transition
     *      and calls `order.confirmPayment` — same path a real gateway would
     *      take after a webhook. One code path for both cases.
     */
    async recordImmediatePayment(params): Promise<PaymentVerificationResult> {
      const engine = getRevenueEngine();
      const repo = engine.repositories.transaction;
      const ctx = toRevenueCtx({
        organizationId: params.organizationId,
        actorRef: params.verifiedBy ?? params.customerId,
        actorKind: 'user',
        correlationId: params.idempotencyKey,
      } as OrderContext);

      const intent = (await repo.createPaymentIntent(
        {
          amount: amountOf(params.amount),
          currency: currencyOf(params.amount),
          gateway: params.gateway,
          paymentData: params.paymentData,
          metadata: { orderId: params.orderId, ...(params.paymentData ?? {}) },
          idempotencyKey: params.idempotencyKey,
          data: {
            sourceId: params.orderId,
            sourceModel: 'Order',
            customerId: params.customerId,
          },
        },
        ctx,
      )) as TxnDoc;

      // Stamp accounting fields BEFORE verify() so the after:update hook
      // sees `branch` populated and the accounting handler posts a journal
      // entry. See stampAccountingFields() for the rationale.
      await stampAccountingFields(repo, intent._id, params.organizationId);

      // For POS orders, source should be 'pos' not 'web' so the
      // day-close aggregator picks them up correctly.
      if (params.gateway === 'pos' || (params.paymentData as { source?: string } | undefined)?.source === 'pos') {
        const model = (repo as unknown as { Model: { updateOne: Function } }).Model;
        await model.updateOne({ _id: intent._id }, { $set: { source: 'pos' } });
      }

      // Idempotent replay or zero-amount intent that's already verified.
      if (intent.status === TRANSACTION_STATUS.VERIFIED) {
        return {
          transactionId: intent._id.toString(),
          status: 'verified',
          amount: intent.amount,
          currency: intent.currency,
          verifiedAt: intent.verifiedAt,
        };
      }

      const intentId = intent.gateway?.sessionId ?? intent.gateway?.paymentIntentId ?? intent._id.toString();
      const verified = (await repo.verify(intentId, { verifiedBy: params.verifiedBy }, ctx)) as TxnDoc;

      return {
        transactionId: verified._id.toString(),
        status: mapVerifyStatus(verified.status),
        amount: verified.amount,
        currency: verified.currency,
        verifiedAt: verified.verifiedAt,
      };
    },

    /**
     * Verify a previously-created intent (webhook callback / admin approval).
     * Delegates to `transaction.verify()` which calls the provider's
     * `verifyPayment` and transitions state.
     */
    async verifyPayment(params): Promise<PaymentVerificationResult> {
      const engine = getRevenueEngine();
      const txn = (await engine.repositories.transaction.verify(params.paymentIdentifier, {
        verifiedBy: params.verifiedBy,
      })) as TxnDoc;

      return {
        transactionId: txn._id.toString(),
        status: mapVerifyStatus(txn.status),
        amount: txn.amount,
        currency: txn.currency,
        verifiedAt: txn.verifiedAt,
      };
    },

    async refundPayment(params): Promise<RefundResult> {
      const engine = getRevenueEngine();
      const refundTxn = (await engine.repositories.transaction.refund(params.transactionId, params.amount ?? null, {
        reason: params.reason,
      })) as TxnDoc & { relatedTransactionId?: { toString(): string }; amount: number };

      const originalId = refundTxn.relatedTransactionId?.toString() ?? params.transactionId;
      const original = (await engine.repositories.transaction.getById(originalId, {
        throwOnNotFound: false,
      })) as (TxnDoc & { amount: number; refundedAmount?: number }) | null;
      const refundedTotal = original?.refundedAmount ?? refundTxn.amount;
      const isPartial = original ? refundedTotal < original.amount : false;

      return {
        originalTransactionId: originalId,
        refundTransactionId: refundTxn._id.toString(),
        refundedAmount: refundTxn.amount,
        isPartialRefund: isPartial,
      };
    },

    // Escrow + split are optional on the RevenueBridge port. They can be
    // implemented later by wrapping `transaction.hold`/`release`/`split`
    // once marketplace flows need them. Omitted here to keep the bridge
    // focused on the payment intent → verify → refund lifecycle.

    /**
     * Saga recovery probe. Used by the order saga to reconcile in-flight
     * payment state after a crash or retry. Returns `'unknown'` if revenue
     * isn't initialized yet — the saga treats that as compensable failure.
     */
    async status(ref: BridgeRef, _ctx: OrderContext): Promise<BridgeStatus> {
      if (!isRevenueReady()) return 'unknown';
      const engine = getRevenueEngine();
      try {
        const txn = (await engine.repositories.transaction.getById(ref.id, {
          throwOnNotFound: false,
        })) as TxnDoc | null;
        if (!txn) return 'unknown';
        return mapTxnToBridgeStatus(txn.status);
      } catch {
        return 'unknown';
      }
    },
  };
}
