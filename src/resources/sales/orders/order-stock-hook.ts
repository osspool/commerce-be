/**
 * Order → Flow stock auto-bridge.
 *
 * POS orders (channel = 'pos') are goods-leave-on-sale: the customer walks
 * out with the product the moment the cashier rings it up. There is no
 * later "ship" step, so stock MUST decrement at order-create time.
 *
 * Web / marketplace / b2b orders go through the standard place → reserve →
 * fulfillment-ship path. They are NOT handled here — this hook is strictly
 * scoped to `isGoodsLeaveOnSaleChannel(channel)`.
 *
 * Mirrors the shape of `order-revenue-hook.ts`:
 *   - subscribed once, idempotent wiring guard
 *   - never throws (the order is already persisted; a failed stock decrement
 *     should be logged and retried, not surface as a misleading 500)
 *   - branch scope comes off the order's `organizationId`
 *
 * **Failure surfacing** — silent skips create ghost inventory (audit found
 * cashier sees order success while stock never moved). The body is split into
 * a pure `attemptStockSync` returning `Result<…, StockSyncError>` plus a
 * single `handleFailure` reaction site that logs at ERROR level, emits
 * `order:pos.stock-sync.failed` on the shared Arc transport, and pushes a
 * note onto the order so it surfaces in the order detail UI's Activity Log
 * (alert-styled for `Stock not deducted:` prefix). Recovery is manual today.
 *
 * The Result shape is from `@classytic/primitives/result` — same `Result<T,E>`
 * the rest of the @classytic kernels use, so consumers/tests can pattern-match
 * with the shared `isOk` / `isErr` helpers without a custom shape per hook.
 */

import type { OrderEngine } from '@classytic/order';
import type { FastifyBaseLogger } from 'fastify';
import { err, isErr, ok, type Result } from '@classytic/primitives/result';
import { buildFlowContext, CUSTOMER_LOCATION, DEFAULT_LOCATION } from '#resources/inventory/flow/context-helpers.js';
import { getFlowEngineOrNull } from '#resources/inventory/flow/flow-engine.js';
import { eventTransport } from '#lib/events/EventBus.js';
import { isGoodsLeaveOnSaleChannel } from './channel.js';

const STOCK_SYNC_FAILED_EVENT = 'order:pos.stock-sync.failed' as const;

type StockSyncFailureReason =
  | 'flow-not-initialized'
  | 'missing-organization-id'
  | 'flow-error';

interface StockSyncError {
  reason: StockSyncFailureReason;
  errorMessage?: string;
}

interface StockSyncFailurePayload extends StockSyncError {
  orderId: string;
  orderNumber: string | undefined;
  organizationId: string | undefined;
  occurredAt: string;
}

/**
 * Human-readable note text for each failure reason. Lives next to the
 * reason enum so adding a new reason forces this map to grow with it
 * (TypeScript exhaustiveness on the switch).
 */
function noteTextFor(reason: StockSyncFailureReason, errorMessage?: string): string {
  switch (reason) {
    case 'flow-not-initialized':
      return 'Stock not deducted: Flow (WMS) engine not initialized. Stock drift — manual reconciliation required.';
    case 'missing-organization-id':
      return 'Stock not deducted: order has no organizationId. Stock drift — manual reconciliation required.';
    case 'flow-error':
      return `Stock not deducted: ${errorMessage ?? 'unknown error'}. Stock drift — review and reconcile manually.`;
  }
}

interface OrderLineSnapshot {
  sku?: string;
  productId?: string;
  name?: string;
}

interface OrderLine {
  lineId: string;
  quantity: number;
  snapshot?: OrderLineSnapshot;
  offerId?: string;
}

interface OrderCreateHookPayload {
  result?: {
    _id?: unknown;
    orderNumber?: string;
    organizationId?: { toString(): string } | string;
    channel?: string;
    lines?: OrderLine[];
  };
  context?: {
    actorRef?: string;
    correlationId?: string;
    [key: string]: unknown;
  };
}

interface StockSyncContext {
  flow: NonNullable<ReturnType<typeof getFlowEngineOrNull>>;
  orderId: string;
  orderNumber: string | undefined;
  channel: string | undefined;
  orgId: string;
  actorRef: string;
  lines: OrderLine[];
}

/**
 * The pure operation. Reads the world (flow engine, orgId), executes the
 * Flow move-group cycle, and returns Result. Free of logging/event/note
 * side-effects so callers can compose, retry, or test it in isolation.
 */
async function attemptStockSync(input: {
  orderId: string;
  orderNumber: string | undefined;
  organizationId: string;
  channel: string | undefined;
  actorRef: string;
  lines: OrderLine[];
}): Promise<Result<{ groupId: string }, StockSyncError>> {
  const flow = getFlowEngineOrNull();
  if (!flow) return err({ reason: 'flow-not-initialized' });

  const flowCtx = buildFlowContext(input.organizationId, input.actorRef);
  try {
    const group = await flow.services.moveGroup.create(
      {
        groupType: 'shipment',
        metadata: {
          orderId: input.orderId,
          orderNumber: input.orderNumber,
          channel: input.channel,
          source: 'pos-auto-decrement',
        },
        items: input.lines.map((line) => ({
          moveGroupId: '',
          operationType: 'shipment',
          skuRef: (line.snapshot?.sku ?? line.offerId) as string,
          sourceLocationId: DEFAULT_LOCATION,
          destinationLocationId: CUSTOMER_LOCATION,
          quantityPlanned: line.quantity,
        })),
      },
      flowCtx,
    );
    const groupId = String(group._id);
    await flow.services.moveGroup.executeAction(groupId, 'confirm', {}, flowCtx);
    await flow.services.moveGroup.executeAction(groupId, 'receive', {}, flowCtx);
    return ok({ groupId });
  } catch (caught) {
    return err({
      reason: 'flow-error',
      errorMessage: (caught as Error).message,
    });
  }
}

/**
 * Single reaction site for any `Result.err` from the sync attempt. Logs,
 * emits, and (when we have an orderNumber + orgId) pushes the failure note.
 * The note prefix `Stock not deducted:` is what the dashboard's
 * ActivityLog component matches to render the alert variant.
 */
async function handleFailure(
  engine: OrderEngine,
  failure: StockSyncError,
  meta: { orderId: string; orderNumber: string | undefined; orgId: string | undefined; actorRef: string },
  logger?: FastifyBaseLogger,
): Promise<void> {
  const payload: StockSyncFailurePayload = {
    ...failure,
    orderId: meta.orderId,
    orderNumber: meta.orderNumber,
    organizationId: meta.orgId,
    occurredAt: new Date().toISOString(),
  };
  logger?.error?.(payload, 'POS order stock decrement failed — order persisted, stock drift possible');

  // Best-effort transport publish. Wrapped so a transport hiccup doesn't
  // swallow the addNote call below.
  try {
    await (eventTransport as unknown as {
      publish: (event: { type: string; data: unknown }) => Promise<void> | void;
    }).publish({ type: STOCK_SYNC_FAILED_EVENT, data: payload });
  } catch (publishErr) {
    logger?.error?.(
      { err: (publishErr as Error).message, ...payload },
      `Failed to publish ${STOCK_SYNC_FAILED_EVENT}`,
    );
  }

  // Note can only be attached when we have both orderNumber (the customId
  // the addNote method dispatches on) and orgId (the tenant scope). The
  // `missing-organization-id` reason intentionally has no note — the
  // event + log are the only surfaces in that case.
  if (meta.orderNumber && meta.orgId) {
    try {
      await engine.repositories.order.addNote(
        meta.orderNumber,
        noteTextFor(failure.reason, failure.errorMessage),
        { organizationId: meta.orgId, actorRef: meta.actorRef } as never,
      );
    } catch (noteErr) {
      logger?.error?.(
        { err: (noteErr as Error).message, orderNumber: meta.orderNumber },
        'Failed to attach stock-sync failure note to order',
      );
    }
  }
}

let wired = false;

export function wireOrderStockHook(engine: OrderEngine, logger?: FastifyBaseLogger): void {
  if (wired) return;
  wired = true;

  engine.repositories.order.on('after:create', async (payload: unknown) => {
    const p = payload as OrderCreateHookPayload;
    const order = p.result;
    if (!order || !order._id) return;
    if (!isGoodsLeaveOnSaleChannel(order.channel)) return;

    const lines = (order.lines ?? []).filter((l) => {
      const skuRef = l.snapshot?.sku ?? l.offerId;
      return skuRef && l.quantity > 0;
    });
    if (lines.length === 0) return;

    const orderId = String(order._id);
    const actorRef = p.context?.actorRef ?? 'order-stock-hook';
    const orgId =
      typeof order.organizationId === 'string' ? order.organizationId : (order.organizationId?.toString() ?? '');

    // Pre-condition: must have an organizationId. Short-circuit before
    // even attempting the sync — no Flow context can be built without it.
    if (!orgId) {
      await handleFailure(
        engine,
        { reason: 'missing-organization-id' },
        { orderId, orderNumber: order.orderNumber, orgId: undefined, actorRef },
        logger,
      );
      return;
    }

    const result = await attemptStockSync({
      orderId,
      orderNumber: order.orderNumber,
      organizationId: orgId,
      channel: order.channel,
      actorRef,
      lines,
    });

    if (isErr(result)) {
      await handleFailure(
        engine,
        result.error,
        { orderId, orderNumber: order.orderNumber, orgId, actorRef },
        logger,
      );
    }
    // ok() = stock decremented, nothing to do.
  });
}

/** Test-only — reset the wired guard between test engine boots. */
export function __resetOrderStockHookWiringForTests(): void {
  wired = false;
}
