/**
 * rma:received → move goods CUSTOMER_LOCATION → RETURN_HOLDING.
 *
 * When the warehouse marks goods physically received the units leave the
 * "in-transit from customer" bucket and land in the quarantine holding bay
 * until QC inspection decides the final destination. Mirrors the
 * `requireInspection` path in change-confirmed-stock-return.ts.
 *
 * Idempotent: guard on rma.metadata.stockReceivedAt (set via $set after
 * the move group executes). A retry that hits the guard is a no-op.
 */

import { RMA_EVENTS } from '@classytic/order';
import { withRetry } from '@classytic/arc/events';
import {
  buildFlowContext,
  CUSTOMER_LOCATION,
  RETURN_HOLDING_LOCATION,
} from '#resources/inventory/flow/context-helpers.js';
import { getFlowEngineOrNull } from '#resources/inventory/flow/flow-engine.js';
import { subscribe } from '#lib/events/arcEvents.js';
import { ensureRmaRepository } from '../rma.engine.js';

export function wireRmaReceivedHandler(): void {
  subscribe(
    RMA_EVENTS.RMA_RECEIVED,
    withRetry(
      async (event: unknown) => {
        const payload = (event as { payload?: Record<string, unknown> }).payload ?? {};
        const rmaNumber = payload.rmaNumber as string | undefined;
        if (!rmaNumber) return;

        const repo = await ensureRmaRepository();
        const rma = await repo.getByQuery(
          { rmaNumber },
          { throwOnNotFound: false } as never,
        );
        if (!rma) return;

        const orgId = String(rma.organizationId ?? '');
        if (!orgId) return;

        const flow = getFlowEngineOrNull();
        if (!flow) return;

        // Idempotency: already moved
        const meta = ((rma as unknown as { metadata?: { stockReceivedAt?: Date } }).metadata) ?? {};
        if (meta.stockReceivedAt) return;

        const receiptCounts = (payload.receiptCounts as Array<{ lineId: string; unitCountReceived: number }>) ?? [];
        const lines = rma.lines ?? [];

        interface MoveItem {
          moveGroupId: string;
          operationType: 'return';
          skuRef: string;
          sourceLocationId: string;
          destinationLocationId: string;
          quantityPlanned: number;
        }
        const items: MoveItem[] = [];
        for (const rc of receiptCounts) {
          if (!rc.unitCountReceived || rc.unitCountReceived <= 0) continue;
          const line = lines.find((l: { lineId: string }) => l.lineId === rc.lineId);
          if (!line?.skuRef) continue;
          items.push({
            moveGroupId: '',
            operationType: 'return',
            skuRef: line.skuRef as string,
            sourceLocationId: CUSTOMER_LOCATION,
            destinationLocationId: RETURN_HOLDING_LOCATION,
            quantityPlanned: rc.unitCountReceived,
          });
        }
        if (items.length === 0) return;

        const flowCtx = buildFlowContext(orgId, 'lifecycle.rma-received');
        const group = await flow.services.moveGroup.create(
          {
            groupType: 'return',
            metadata: {
              rmaNumber,
              orderNumber: payload.orderNumber,
              source: 'lifecycle.rma-received',
            },
            items,
          },
          flowCtx,
        );
        await flow.services.moveGroup.executeAction(String(group._id), 'confirm', {}, flowCtx);
        await flow.services.moveGroup.executeAction(String(group._id), 'receive', {}, flowCtx);

        await (rma.constructor as { updateOne?: (f: unknown, u: unknown) => Promise<void> })
          .updateOne?.({ rmaNumber }, { $set: { 'metadata.stockReceivedAt': new Date() } });
      },
      {
        maxRetries: 3,
        backoffMs: 2000,
        name: 'lifecycle.rma-received',
        onDead: (e) => console.error({ event: e, handler: 'lifecycle.rma-received' }, 'rma-received handler dead'),
      },
    ),
  ).catch((err) => console.error({ err }, 'rma-received: subscribe failed'));
}
