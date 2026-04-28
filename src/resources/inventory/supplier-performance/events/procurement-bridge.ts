/**
 * Procurement → Supplier Performance bridge.
 *
 * Subscribes to `flow.procurement.received` and converts each received PO
 * into one of two performance events:
 *   - `delivery_received` when actual ≤ expected
 *   - `delivery_late`     with `delayDays = floor((actual - expected) / day)` otherwise
 *
 * The flow event payload is intentionally lean (`itemCount`, `isPartial`)
 * so we re-fetch the PO to read `expectedAt` and the line totals. One
 * extra round-trip per receipt is cheap; the alternative (enriching the
 * flow event payload) is kernel work and changes a public schema.
 *
 * Idempotency: the supplier-performance kernel doesn't dedupe — same
 * (sourceRef, type) pair can land twice on retry. If a host needs strict
 * once-only semantics, set `metadata.idempotencyKey` and add a partial
 * unique index on `metrics.idempotencyKey` from a custom plugin. For
 * now, the bridge fires once per receipt event; re-publishes are rare
 * and the score-aggregation algorithm tolerates duplicates by averaging
 * — they shift the score but don't corrupt it.
 *
 * The kernel never imports flow. This file is the deliberate seam.
 */
import type { DomainEvent } from '@classytic/arc/events';
import { subscribe } from '#lib/events/arcEvents.js';
import logger from '#lib/utils/logger.js';
import { getFlowEngineOrNull } from '#resources/inventory/flow/flow-engine.js';
import {
  ensureSupplierPerformanceEngine,
  getSupplierPerformanceEngineOrNull,
} from '../supplier-performance.engine.js';

interface ProcurementReceivedPayload {
  organizationId: string;
  orderId: string;
  orderNumber: string;
  vendorRef: string;
  destinationNodeId: string;
  itemCount: number;
  isPartial?: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

let registered = false;

export function registerProcurementBridge(): void {
  if (registered) return;
  registered = true;

  // Boot the supplier-performance engine eagerly — first call kicks
  // model registration. Boot failures here are surfaced as logs; the
  // bridge stays installed but no-ops until the engine is ready.
  void ensureSupplierPerformanceEngine().catch((err) =>
    logger.error({ err: (err as Error).message }, '[supplier-performance] engine init failed'),
  );

  void subscribe('flow.procurement.received', async (event: DomainEvent) => {
    const payload = (event.payload ?? {}) as ProcurementReceivedPayload;
    if (!payload.orderId || !payload.vendorRef) return;

    const orgId = payload.organizationId ?? event.meta?.organizationId ?? '';
    if (!orgId) return;

    const flow = getFlowEngineOrNull();
    const sp = getSupplierPerformanceEngineOrNull() ?? (await ensureSupplierPerformanceEngine());
    if (!flow) return;

    const ctx = {
      organizationId: orgId,
      actorRef: event.meta?.userId ?? 'system',
      actorKind: 'system' as const,
      correlationId: event.meta?.correlationId ?? '',
    };

    try {
      const order = (await flow.repositories.procurement.getByQuery(
        { _id: payload.orderId },
        { organizationId: orgId, throwOnNotFound: false, lean: true },
      )) as
        | {
            expectedAt?: Date;
            items?: Array<{ quantity?: number; quantityReceived?: number }>;
          }
        | null;
      if (!order) return;

      const actualAt = event.meta?.timestamp ?? new Date();
      const totalReceived = (order.items ?? []).reduce(
        (s, item) => s + Number(item.quantityReceived ?? 0),
        0,
      );

      let type: 'delivery_received' | 'delivery_late' = 'delivery_received';
      let delayDays: number | undefined;
      if (order.expectedAt) {
        const diff = actualAt.getTime() - new Date(order.expectedAt).getTime();
        if (diff > 0) {
          type = 'delivery_late';
          delayDays = Math.ceil(diff / MS_PER_DAY);
        }
      }

      await sp.services.score.recordEvent(
        {
          supplierId: payload.vendorRef,
          type,
          occurredAt: actualAt,
          metrics: {
            quantity: totalReceived,
            ...(order.expectedAt ? { expectedAt: new Date(order.expectedAt) } : {}),
            actualAt,
            ...(delayDays !== undefined ? { delayDays } : {}),
          },
          sourceRef: payload.orderNumber,
          sourceType: 'procurement_order',
        },
        ctx,
      );
    } catch (err) {
      logger.error(
        { err: (err as Error).message, orderNumber: payload.orderNumber },
        '[supplier-performance] procurement-bridge failed',
      );
    }
  });

  logger.info('[supplier-performance] procurement bridge registered');
}
