/**
 * Order payment helper — wires every order-create path (Arc CRUD POST /orders,
 * POS POST /pos/orders, custom POST /orders/place) to the revenue bridge.
 *
 * Routing rule (channel-first, then gateway):
 *
 *   POS channel                   → recordImmediatePayment (VERIFIED on insert)
 *   gateway is cash/cod equivalent → recordImmediatePayment (no verification step)
 *   gateway has a real provider    → createPaymentIntent → deferred webhook
 *   everything else (bKash, etc.)  → createPaymentIntent → PENDING, awaits
 *                                    admin verify via /payments/manual/verify
 *
 * Why this matters: today bKash on web means "user typed a TrxID, manager
 * eyeballs it later." Auto-verifying that on insert would mark fake orders
 * paid. POS is different — cash is in the drawer the moment the order is
 * placed, so we mark VERIFIED right away and let the after:update hook
 * post the journal entry.
 */

import type {
  OrderContext,
  OrderTotals,
  PaymentIntentResult,
  PaymentVerificationResult,
  RevenueBridge,
} from '@classytic/order';
import { resolveMethodKind } from '#shared/payments/method-kind.js';

export interface OrderPaymentInput {
  method?: string;
  gateway?: string;
  reference?: string;
  cashReceived?: number;
  [key: string]: unknown;
}

export interface OrderLike {
  _id: unknown;
  orderNumber?: string;
  channel?: string;
  totals?: OrderTotals;
  customer?: { _id?: string; email?: string; name?: string };
}

export interface PaymentAttachResult {
  kind: 'immediate' | 'deferred' | 'skipped';
  transactionId?: string;
  status?: string;
  paymentUrl?: string;
  clientSecret?: string;
  error?: string;
}

/**
 * Cash-equivalent gateways — payment is real at the moment the order is
 * placed regardless of channel. Cash in hand has no verification step.
 *
 * Anything NOT in this set on a non-POS channel goes through the deferred
 * intent flow (PENDING transaction → admin verify → after:update hook
 * → ledger posting). That's what bKash/Nagad/Rocket/Upay/card-online do
 * today: the user types a TrxID, the manager verifies it from the admin
 * UI, the existing /payments/manual/verify handler flips the txn to
 * VERIFIED, and the rest of the chain fires automatically.
 */
const ALWAYS_IMMEDIATE_GATEWAYS = new Set(['cash', 'cod', 'pos']);

function shouldVerifyImmediately(gateway: string, channel: string | undefined): boolean {
  if (ALWAYS_IMMEDIATE_GATEWAYS.has(gateway.toLowerCase())) return true;
  // POS channel: every payment is settled at the terminal (cash drawer,
  // bank-card POS device, MFS QR scan that the operator confirms).
  // Mirrors Odoo's `point_of_sale` module which closes the journal entry
  // synchronously per ticket.
  if (channel === 'pos') return true;
  return false;
}

function orderTotalAmount(order: OrderLike): { amount: number; currency: string } | null {
  const total = order.totals?.grandTotal;
  if (!total || typeof total.amount !== 'number') return null;
  return { amount: total.amount, currency: total.currency ?? 'BDT' };
}

/**
 * Attach a payment transaction to a just-created order via the revenue bridge.
 *
 * Non-throwing: if the bridge or revenue engine isn't ready, or the provider
 * rejects, we return a `{ kind: 'skipped', error }` result. The order itself
 * is already persisted; reservations are already held; the caller decides
 * whether to 500 the request or let the user retry payment separately.
 */
export async function attachPaymentToOrder(params: {
  order: OrderLike;
  payment: OrderPaymentInput | undefined;
  ctx: OrderContext;
  bridge?: RevenueBridge;
  idempotencyKey: string;
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}): Promise<PaymentAttachResult> {
  const { order, payment, ctx, bridge, idempotencyKey, logger } = params;
  if (!bridge) return { kind: 'skipped', error: 'revenue_bridge_unavailable' };

  const gateway = (payment?.gateway ?? payment?.method ?? 'manual').toString();
  const amount = orderTotalAmount(order);
  if (!amount) return { kind: 'skipped', error: 'order_total_missing' };

  const orderId = String(order._id ?? '');
  const customerId = order.customer?._id ?? ctx.actorRef;

  try {
    if (shouldVerifyImmediately(gateway, order.channel)) {
      const result: PaymentVerificationResult = await bridge.recordImmediatePayment({
        orderId,
        organizationId: ctx.organizationId!,
        customerId,
        amount,
        gateway,
        methodKind: resolveMethodKind(gateway),
        paymentData: payment as Record<string, unknown>,
        verifiedBy: ctx.actorRef,
        idempotencyKey,
      });
      return { kind: 'immediate', transactionId: result.transactionId, status: result.status };
    }

    const result: PaymentIntentResult = await bridge.createPaymentIntent({
      orderId,
      organizationId: ctx.organizationId!,
      customerId,
      amount,
      gateway,
      methodKind: resolveMethodKind(gateway),
      metadata: payment as Record<string, unknown>,
      idempotencyKey,
    });
    return {
      kind: 'deferred',
      transactionId: result.transactionId,
      status: result.status,
      paymentUrl: result.paymentUrl,
      clientSecret: result.clientSecret,
    };
  } catch (err) {
    const message = (err as Error).message ?? 'payment_bridge_error';
    logger?.warn({ err: message, gateway, orderNumber: order.orderNumber }, 'payment_bridge_failed');
    return { kind: 'skipped', error: message };
  }
}
