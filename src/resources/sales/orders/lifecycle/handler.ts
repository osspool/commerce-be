/**
 * Order lifecycle handler contract.
 *
 * Every side-effect that fires off an order-FSM transition (stock commit,
 * stock return, ledger COGS post, COGS reversal, ...) is expressed as a
 * `TransitionHandler`. The wirer in `wire-handlers.ts` subscribes each
 * handler to its declared event with retry / dead-letter via
 * `@classytic/arc/events.withRetry` — handlers themselves are plain async
 * functions that take a typed `TransitionContext` plus injected
 * `HandlerDeps`, so unit tests just call `handler.handle(ctx, fakeDeps)`
 * with no event-bus or HTTP setup.
 *
 * Add a new side-effect = add a file in `handlers/`, add it to the
 * `HANDLERS` array in `wire-handlers.ts`. No other touchpoints.
 */

import type { OrderEngine } from '@classytic/order';
import type { FastifyBaseLogger } from 'fastify';
import type { getFlowEngineOrNull } from '#resources/inventory/flow/flow-engine.js';

/**
 * Normalised payload for any order-or-fulfillment FSM event.
 *
 * The order package emits two distinct shapes through `eventTransport`:
 *
 *   - **Order events** (`order:fulfilled`, `order:refunded`, ...) carry
 *     `{ orderNumber, fromStatus, toStatus, reason }`.
 *   - **Fulfillment events** (`order:fulfillment.transition`,
 *     `order:fulfillment.completed`, `order:fulfillment.canceled`) carry
 *     `{ orderNumber, fulfillmentNumber, fromStatus, toStatus }`.
 *
 * Both share the `orderNumber + fromStatus + toStatus` triple. Fulfillment
 * events additionally carry `fulfillmentNumber`. Handlers that subscribe
 * to fulfillment events read `fulfillmentNumber` to load the doc;
 * order-event handlers ignore the field. None of the fields are
 * individually guaranteed — handlers validate what they care about and
 * return early when the trigger isn't actionable (e.g. a refund that
 * hasn't been through fulfilled yet, or a fulfillment transition into
 * a non-stock-affecting state like `picking`).
 */
export interface TransitionContext {
  orderNumber: string;
  fromStatus?: string;
  toStatus?: string;
  reason?: string;
  /** Only set on `order:fulfillment.*` events. */
  fulfillmentNumber?: string;
  /** Set by the dispatcher after looking the order up — handlers don't
   *  re-fetch when this is present. */
  organizationId?: string;
  /** Set by the dispatcher when the doc has already been loaded. */
  orderId?: string;
  /** Only set on `order:change.*` events (RMA workflow). */
  changeNumber?: string;
}

/**
 * Bag of dependencies a handler can pull on. Tests construct a stub object
 * literal with just the fields a particular handler touches; production
 * wiring builds the full set in `wire-handlers.ts`.
 */
export interface HandlerDeps {
  engine: OrderEngine;
  /** Flow engine accessor. Returns null when Flow isn't initialised — handlers
   *  that need stock movements no-op gracefully in that case. */
  flow: ReturnType<typeof getFlowEngineOrNull>;
  /** Arc event publisher (used by ledger bridge handlers to fan out into
   *  the accounting domain). */
  publish: (type: string, payload: Record<string, unknown>) => Promise<void>;
  logger: FastifyBaseLogger | Pick<Console, 'info' | 'warn' | 'error' | 'debug'>;
  /** Optional clock injection for date-sensitive handlers in tests. */
  now?: () => Date;
}

export interface TransitionHandler {
  /** Event name to subscribe to (e.g. `order:fulfilled`). */
  readonly event: string;
  /** Stable name surfaced in retry / dead-letter logs. */
  readonly name: string;
  /** Side-effect implementation. MUST be idempotent — `withRetry` may invoke
   *  it more than once on transient failures. */
  handle(ctx: TransitionContext, deps: HandlerDeps): Promise<void>;
}
