/**
 * rma:inspected → route goods from RETURN_HOLDING to final destinations.
 *
 * Per-line disposition map (from the kernel's inspect() result):
 *   restock         → DEFAULT_LOCATION  (sellable; COGS reversal via rma:resolved)
 *   scrap           → ADJUSTMENT_LOCATION (write-off)
 *   return_to_vendor→ VENDOR_LOCATION
 *   refurbish       → RETURN_HOLDING (stays quarantined — ops handles B-grade workflow)
 *   quarantine      → RETURN_HOLDING (hold for investigation)
 *
 * Idempotency: guard on rma.metadata.stockInspectedAt.
 */

import { RMA_EVENTS } from '@classytic/order';
import { withRetry } from '@classytic/arc/events';
import {
  ADJUSTMENT_LOCATION,
  buildFlowContext,
  DEFAULT_LOCATION,
  RETURN_HOLDING_LOCATION,
  VENDOR_LOCATION,
} from '#resources/inventory/flow/context-helpers.js';
import { getFlowEngineOrNull } from '#resources/inventory/flow/flow-engine.js';
import { subscribe } from '#lib/events/arcEvents.js';
import { ensureRmaRepository } from '../rma.engine.js';

const DISPOSITION_DESTINATION: Record<string, string> = {
  restock: DEFAULT_LOCATION,
  scrap: ADJUSTMENT_LOCATION,
  return_to_vendor: VENDOR_LOCATION,
  refurbish: RETURN_HOLDING_LOCATION,
  quarantine: RETURN_HOLDING_LOCATION,
};

export function wireRmaInspectedHandler(): void {
  subscribe(
    RMA_EVENTS.RMA_INSPECTED,
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

        // Idempotency: already routed
        const meta = ((rma as unknown as { metadata?: { stockInspectedAt?: Date } }).metadata) ?? {};
        if (meta.stockInspectedAt) return;

        const dispositions = (
          payload.dispositions as Array<{
            lineId: string;
            disposition: string;
            unitCountAccepted: number;
          }>
        ) ?? [];

        const lines = rma.lines ?? [];

        interface MoveItem {
          moveGroupId: string;
          operationType: 'return';
          skuRef: string;
          sourceLocationId: string;
          destinationLocationId: string;
          quantityPlanned: number;
        }

        // Group items by destination to minimise move groups
        const byDest = new Map<string, MoveItem[]>();
        for (const d of dispositions) {
          if (!d.unitCountAccepted || d.unitCountAccepted <= 0) continue;
          const dest = DISPOSITION_DESTINATION[d.disposition] ?? RETURN_HOLDING_LOCATION;

          // Units that stay in RETURN_HOLDING need no move
          if (dest === RETURN_HOLDING_LOCATION) continue;

          const line = lines.find((l: { lineId: string }) => l.lineId === d.lineId);
          if (!line?.skuRef) continue;

          const item: MoveItem = {
            moveGroupId: '',
            operationType: 'return',
            skuRef: line.skuRef as string,
            sourceLocationId: RETURN_HOLDING_LOCATION,
            destinationLocationId: dest,
            quantityPlanned: d.unitCountAccepted,
          };
          const bucket = byDest.get(dest) ?? [];
          bucket.push(item);
          byDest.set(dest, bucket);
        }

        const flowCtx = buildFlowContext(orgId, 'lifecycle.rma-inspected');
        for (const [dest, items] of byDest) {
          const group = await flow.services.moveGroup.create(
            {
              groupType: 'return',
              metadata: {
                rmaNumber,
                orderNumber: payload.orderNumber,
                destination: dest,
                source: 'lifecycle.rma-inspected',
              },
              items,
            },
            flowCtx,
          );
          await flow.services.moveGroup.executeAction(String(group._id), 'confirm', {}, flowCtx);
          await flow.services.moveGroup.executeAction(String(group._id), 'receive', {}, flowCtx);
        }

        await (rma.constructor as { updateOne?: (f: unknown, u: unknown) => Promise<void> })
          .updateOne?.({ rmaNumber }, { $set: { 'metadata.stockInspectedAt': new Date() } });
      },
      {
        maxRetries: 3,
        backoffMs: 2000,
        name: 'lifecycle.rma-inspected',
        onDead: (e) => console.error({ event: e, handler: 'lifecycle.rma-inspected' }, 'rma-inspected handler dead'),
      },
    ),
  ).catch((err) => console.error({ err }, 'rma-inspected: subscribe failed'));
}
