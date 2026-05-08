/**
 * Revenue Plugin — @classytic/revenue v2
 *
 * Initializes the revenue engine at app boot and wires two kinds of
 * subscribers on the transaction repository:
 *
 *   1. Mongokit `after:update` — the raw Arc/mongokit hook. Fires on every
 *      update, including the state transitions performed by domain verbs
 *      (verify / refund / hold / release / split). We bridge verified
 *      payments to the order engine (`confirmPayment`) and mirror refunds
 *      + verifications to the accounting outbox.
 *
 *   2. No package-local event bus — per PACKAGE_RULES §11–§14, events flow
 *      via mongokit hooks; the host composes the outbox using Arc's
 *      transport (or a 20-line cron relay).
 *
 * The v1 `Revenue.create().withPlugin()` / `revenueInstance.on()` API is
 * gone. Same behavior, different entry points.
 */

import type { TransactionDocument } from '@classytic/revenue';
import { TRANSACTION_STATUS } from '@classytic/revenue/enums';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import config from '#config/index.js';
import { destroyRevenueEngine, ensureRevenueEngine } from './engine.js';
import { updateEntityAfterPaymentVerification } from './payment-verification.utils.js';

interface TxnLike {
  _id: { toString(): string };
  amount: number;
  currency: string;
  method: string;
  status: string;
  sourceModel?: string;
  sourceId?: string;
  verifiedAt?: Date;
  verifiedBy?: string;
  branch?: unknown;
  source?: string;
  metadata?: Record<string, unknown>;
  tax?: number;
  taxDetails?: unknown;
  [key: string]: unknown;
}

async function publishAccountingEvent(
  eventType: 'accounting:order.paid' | 'accounting:transaction.refunded',
  payload: Record<string, unknown>,
  log: FastifyInstance['log'],
): Promise<void> {
  try {
    const [{ outbox }, { createEvent }] = await Promise.all([
      import('#shared/outbox/index.js'),
      import('@classytic/primitives/events'),
    ]);
    await outbox.store(createEvent(eventType, payload));
  } catch (err) {
    log.warn({ err: (err as Error).message, eventType }, 'Failed to store event in outbox');
  }
}

async function revenuePlugin(fastify: FastifyInstance): Promise<void> {
  fastify.log.info('Initializing revenue engine (v2)');

  const engine = await ensureRevenueEngine({
    logger: fastify.log,
    isProduction: config.isProduction,
  });

  const repo = engine.repositories.transaction;

  // ─── Bridge: verified payments → order engine + accounting outbox ───
  repo.on('after:update', async (payload: { context?: unknown; result?: unknown } | unknown) => {
    // mongokit builds the update context with `{ id, data, ...options }`,
    // so the update payload lives on `context.data`. An earlier version of
    // this plugin read `context.updates`, which was silently always empty —
    // the hook never actually observed the VERIFIED transition, and the
    // order→revenue bridge was dark. Pinned by
    // `tests/integration/revenue-order-workflow.test.ts`.
    const p = payload as { context?: { data?: Record<string, unknown> }; result?: TxnLike };
    const txn = p?.result;
    const updates = p?.context?.data ?? {};

    if (!txn) return;

    const becameVerified =
      (updates as { status?: string }).status === TRANSACTION_STATUS.VERIFIED &&
      txn.status === TRANSACTION_STATUS.VERIFIED;

    if (!becameVerified) return;

    fastify.log.info(
      {
        transactionId: txn._id.toString(),
        amount: txn.amount,
        method: txn.method,
        sourceModel: txn.sourceModel,
        sourceId: txn.sourceId,
      },
      'revenue:payment.verified',
    );

    // Bridge to order engine — confirmPayment drives FSM + chargeStatus in one call.
    if (txn.sourceModel && txn.sourceId) {
      try {
        await updateEntityAfterPaymentVerification(
          txn.sourceModel,
          txn.sourceId,
          {
            _id: txn._id as never,
            amount: txn.amount,
            currency: txn.currency,
            method: txn.method,
            gateway: typeof txn.gateway === 'object' ? (txn.gateway as { type?: string }).type : undefined,
            // organizationId MUST be forwarded — payment-verification.utils
            // builds its OrderContext from it to query/update the linked
            // order. Leaving it off silently cast-fails the query.
            organizationId: (txn as { organizationId?: unknown }).organizationId as never,
            sourceModel: txn.sourceModel,
            sourceId: txn.sourceId,
            verifiedAt: txn.verifiedAt,
            verifiedBy: txn.verifiedBy as never,
            paymentDetails: (txn as { paymentDetails?: Record<string, unknown> }).paymentDetails,
          } as never,
          fastify.log,
        );
      } catch (err) {
        fastify.log.error(
          { err: (err as Error).message, transactionId: txn._id.toString() },
          'Order bridge failed after payment verification',
        );
      }
    }

    // Mirror to accounting outbox if enabled.
    if (config.accounting?.enabled) {
      await publishAccountingEvent('accounting:order.paid', { transactionId: txn._id.toString() }, fastify.log);
    }
  });

  // ─── Bridge: refund transactions → accounting outbox ───
  //
  // Revenue v2's `refund` creates a new outflow transaction and updates the
  // original. We subscribe to `after:create` and filter for refund-flow docs
  // (v2 doesn't emit an application-level "refund" event; the data shape
  // is the signal).
  repo.on('after:create', async (payload: { context?: unknown; result?: unknown } | unknown) => {
    const p = payload as { result?: TxnLike };
    const txn = p?.result;
    if (!txn || txn.type !== 'refund' || txn.flow !== 'outflow') return;

    fastify.log.info(
      {
        refundTransactionId: txn._id.toString(),
        originalTransactionId: txn.relatedTransactionId?.toString(),
        amount: txn.amount,
      },
      'revenue:payment.refunded',
    );

    await publishAccountingEvent(
      'accounting:transaction.refunded',
      {
        transactionId: txn.relatedTransactionId?.toString(),
        refundTransactionId: txn._id.toString(),
        refundAmount: txn.amount,
      },
      fastify.log,
    );
  });

  fastify.decorate('revenue', engine);

  fastify.addHook('onClose', async () => {
    await destroyRevenueEngine();
  });

  fastify.log.info(
    {
      providers: Object.keys(engine.providers ?? {}),
      modules: { subscription: !!engine.repositories.subscription, settlement: !!engine.repositories.settlement },
    },
    'Revenue engine initialized',
  );
}

export default fp(revenuePlugin, {
  name: 'revenue',
  dependencies: ['register-core-plugins'],
});
