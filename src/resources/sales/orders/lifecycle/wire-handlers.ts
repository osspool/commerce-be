/**
 * Single registration point for every order-lifecycle handler.
 *
 * Pattern: declare each side-effect as a `TransitionHandler` (event + name +
 * pure async `handle`), drop it in the `HANDLERS` array below, the wirer
 * subscribes them all under `@classytic/arc/events.withRetry` for a
 * uniform retry / dead-letter envelope. Adding a new effect is one file +
 * one line in this array — no engine wiring, no plugin orchestration.
 *
 * Idempotent across HMR / cron / plugin / background-runtime bootstraps via
 * the `wired` module guard, mirroring the pattern in
 * `accounting.events.registerAccountingEventHandlers`.
 */

import { withRetry } from '@classytic/arc/events';
import type { OrderEngine } from '@classytic/order';
import type { FastifyBaseLogger } from 'fastify';
import { publish, subscribe } from '#lib/events/arcEvents.js';
import { getFlowEngineOrNull } from '#resources/inventory/flow/flow-engine.js';
import type { HandlerDeps, TransitionContext, TransitionHandler } from './handler.js';
import { cancelRefundPrepaidHandler } from './handlers/cancel-refund-prepaid.js';
import { changeConfirmedExchangeReplacementHandler } from './handlers/change-confirmed-exchange-replacement.js';
import { changeConfirmedLedgerRestockBridgeHandler } from './handlers/change-confirmed-ledger-restock-bridge.js';
import { changeConfirmedRefundHandler } from './handlers/change-confirmed-refund.js';
import { changeConfirmedRestockingFeeHandler } from './handlers/change-confirmed-restocking-fee.js';
import { changeConfirmedStockReturnHandler } from './handlers/change-confirmed-stock-return.js';
import { fulfillmentDeliveredHandler } from './handlers/fulfillment-delivered.js';
import { ledgerCogsBridgeHandler } from './handlers/ledger-cogs-bridge.js';
import { ledgerRestockBridgeHandler } from './handlers/ledger-restock-bridge.js';
import { stockCommitHandler } from './handlers/stock-commit.js';
import { stockReturnHandler } from './handlers/stock-return.js';

/**
 * The ordered registry of every lifecycle side-effect. Order matters when
 * two handlers for the same event have a producer/consumer relationship —
 * Arc's MemoryEventTransport invokes subscribers in registration order, so
 * if a later handler depends on a side-effect of an earlier one, list the
 * earlier one first. (Today nothing in here has cross-handler ordering
 * requirements: stock-* talk to Flow, ledger-*-bridge fan out to a separate
 * accounting subscriber chain.)
 */
const HANDLERS: ReadonlyArray<TransitionHandler> = [
  stockCommitHandler,
  ledgerCogsBridgeHandler,
  // Promote the fulfillment-level `delivered` transition to a durable
  // ORDER-subject event so /orders/:id/events shows it in the timeline
  // and notification / settlement-import subscribers can react to a
  // canonical signal. See [handlers/fulfillment-delivered.ts] for the
  // rationale (COD reconciliation, dashboard delivered timestamp,
  // customer "your order is delivered" emails).
  fulfillmentDeliveredHandler,
  // Money-movement: cancel of a prepaid order issues a gateway refund and
  // stamps the order. order:refunded then triggers the stock + ledger
  // chain via stockReturnHandler / ledgerRestockBridgeHandler when goods
  // had already shipped.
  cancelRefundPrepaidHandler,
  // RMA confirm path: customer self-service return / exchange / claim.
  // Goods movement, COGS reversal, and money movement are decoupled here so
  // partial RMAs and COD orders all land correctly:
  //   • `changeConfirmedStockReturnHandler` restocks the returned units in
  //     Flow regardless of payment gateway (Odoo / Shopify pattern —
  //     physical inventory is independent of credit-note settlement).
  //   • `changeConfirmedLedgerRestockBridgeHandler` posts the partial COGS
  //     reversal JE for the cost basis of the returned quantity. Same
  //     decoupling: independent of payment gateway, per-line precision.
  //   • `changeConfirmedRefundHandler` issues the gateway refund (skipped
  //     for COD; ops settle that manually) and, if the cumulative refund
  //     covers the full order, transitions the order to `refunded` so
  //     `stockReturnHandler` + `ledgerRestockBridgeHandler` fan out.
  //     Those two have RMA-aware guards so they don't double-act on partial
  //     RMA → full refund paths.
  changeConfirmedStockReturnHandler,
  changeConfirmedLedgerRestockBridgeHandler,
  changeConfirmedRestockingFeeHandler,
  changeConfirmedExchangeReplacementHandler,
  changeConfirmedRefundHandler,
  stockReturnHandler,
  ledgerRestockBridgeHandler,
];

let wired = false;

export function wireOrderLifecycleHandlers(
  engine: OrderEngine,
  logger?: FastifyBaseLogger,
): void {
  if (wired) return;
  wired = true;

  const baseLog: HandlerDeps['logger'] = logger ?? console;

  for (const handler of HANDLERS) {
    subscribe(
      handler.event,
      withRetry(
        async (event: unknown) => {
          const ctx = extractTransitionContext(event);
          // change.* events carry only `changeNumber`; the rest of the
          // events carry `orderNumber`. Skip only when both are missing.
          if (!ctx.orderNumber && !ctx.changeNumber) return;
          const deps: HandlerDeps = {
            engine,
            flow: getFlowEngineOrNull(),
            publish,
            logger: baseLog,
          };
          await handler.handle(ctx, deps);
        },
        {
          maxRetries: 3,
          backoffMs: 2000,
          name: handler.name,
          onDead: (event) => {
            baseLog.error?.({ event, handler: handler.name }, 'lifecycle handler exhausted retries');
          },
        },
      ),
    )
      .then(() =>
        baseLog.debug?.({ handler: handler.name, event: handler.event }, 'lifecycle handler subscribed'),
      )
      .catch((err) => {
        baseLog.error?.(
          { handler: handler.name, event: handler.event, err: (err as Error).message },
          'lifecycle handler FAILED to subscribe',
        );
      });
  }

  baseLog.info?.({ count: HANDLERS.length }, 'Order lifecycle handlers registered');
}

/**
 * Pull the canonical transition fields out of the wire-format event. The
 * order package emits two related shapes:
 *
 *   - Order FSM events carry `{ orderNumber, fromStatus, toStatus, reason }`.
 *   - Fulfillment FSM events carry `{ orderNumber, fulfillmentNumber,
 *     fromStatus, toStatus }`.
 *
 * Both keys land on the same `TransitionContext` so the handler factory
 * is one shape; handlers that only care about one event type validate
 * the fields they need (a fulfillment handler returns early if
 * `fulfillmentNumber` is missing, etc.).
 */
function extractTransitionContext(event: unknown): TransitionContext {
  const payload = (event as { payload?: Record<string, unknown> }).payload ?? {};
  return {
    orderNumber: String(payload.orderNumber ?? ''),
    fromStatus: payload.fromStatus as string | undefined,
    toStatus: payload.toStatus as string | undefined,
    reason: payload.reason as string | undefined,
    fulfillmentNumber: payload.fulfillmentNumber as string | undefined,
    changeNumber: payload.changeNumber as string | undefined,
  };
}

/** Test-only — reset the wired guard between test engine boots. */
export function __resetOrderLifecycleHandlersForTests(): void {
  wired = false;
}
