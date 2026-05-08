/**
 * RFQ → Procurement bridge.
 *
 * Subscribes to `order:rfq.awarded` and creates the actual PO via
 * `@classytic/flow`'s procurement service, then calls
 * `rfqRepository.recordPoGenerated()` to stamp the back-reference and
 * emit `order:rfq.po_generated`.
 *
 * The kernel never imports flow — that's a PACKAGE_RULES rule (no
 * `@classytic/*` sibling imports). This file is the deliberate seam.
 *
 * Idempotency: if the RFQ already carries a `generatedPoRef`, the bridge
 * is a no-op. Crash recovery: a host cron could re-fire awards by
 * re-publishing the event; the idempotency check ensures no duplicate POs.
 */
import type { DomainEvent } from '@classytic/primitives/events';
import { repoOptionsFromCtx } from '@classytic/order';
import { subscribe } from '#lib/events/arcEvents.js';
import logger from '#lib/utils/logger.js';
import { buildFlowContext } from '#resources/inventory/flow/context-helpers.js';
import { getFlowEngineOrNull } from '#resources/inventory/flow/flow-engine.js';
import { rfqRepository } from '../rfq.engine.js';

interface RfqAwardedPayload {
  rfqNumber: string;
  vendorId: string;
  totalPrice: { amount: number; currency: string };
  leadTimeDays: number;
  awardedBy: string;
  awardedAt: string;
}

let registered = false;

export function registerRfqAwardBridge(): void {
  if (registered) return;
  registered = true;

  void subscribe('order:rfq.awarded', async (event: DomainEvent) => {
    const payload = (event.payload ?? {}) as RfqAwardedPayload;
    const orgId = event.meta?.organizationId ?? '';
    const actorRef = event.meta?.userId ?? payload.awardedBy ?? 'system';

    if (!payload.rfqNumber || !orgId) {
      logger.warn({ payload, meta: event.meta }, '[rfq] award-bridge missing rfqNumber or org');
      return;
    }

    const ctx = {
      organizationId: orgId,
      actorRef,
      actorKind: 'system' as const,
      correlationId: event.meta?.correlationId ?? '',
    };

    try {
      // Reload the RFQ — the event payload only carries summary data.
      // Lines, line counts, target costs all live on the doc.
      const rfq = await rfqRepository.getByQuery(
        { rfqNumber: payload.rfqNumber },
        repoOptionsFromCtx(ctx),
      );
      if (!rfq) {
        logger.warn({ rfqNumber: payload.rfqNumber }, '[rfq] award-bridge: RFQ not found');
        return;
      }

      // Idempotency — if we've already generated a PO for this award, skip.
      if (rfq.generatedPoRef) {
        logger.debug(
          { rfqNumber: payload.rfqNumber, poNumber: (rfq.generatedPoRef as { poNumber?: string }).poNumber },
          '[rfq] award-bridge: PO already generated',
        );
        return;
      }

      const flow = getFlowEngineOrNull();
      if (!flow) {
        logger.warn({ rfqNumber: payload.rfqNumber }, '[rfq] award-bridge: flow engine unavailable');
        return;
      }

      // Find winning response — its lines drive the PO (vendor may have
      // bundled / substituted compared to original RfqLineItems).
      const responses = (rfq.responses as Array<{
        vendorId: string;
        lines: Array<{ lineId: string; unitPrice: { amount: number; currency: string }; quantity: number }>;
      }>);
      const winner = responses.find((r) => r.vendorId === payload.vendorId);
      if (!winner) {
        logger.warn(
          { rfqNumber: payload.rfqNumber, vendorId: payload.vendorId },
          '[rfq] award-bridge: winning response not found on doc',
        );
        return;
      }

      // Resolve each PO line against the original RfqLineItem to recover
      // skuRef (required by procurement). RfqLineItem.skuRef is optional —
      // pure-service RFQs without an internal SKU can't auto-generate a PO.
      const lineItems = rfq.lineItems as Array<{ lineId: string; skuRef?: string }>;
      const skuByLineId = new Map(lineItems.map((li) => [li.lineId, li.skuRef]));
      const procurementItems: Array<{ skuRef: string; quantity: number; unitCost: number }> = [];
      const skippedLines: string[] = [];
      for (const wl of winner.lines) {
        const skuRef = skuByLineId.get(wl.lineId);
        if (!skuRef) {
          skippedLines.push(wl.lineId);
          continue;
        }
        procurementItems.push({
          skuRef,
          quantity: wl.quantity,
          unitCost: wl.unitPrice.amount,
        });
      }
      if (skippedLines.length > 0) {
        logger.warn(
          { rfqNumber: payload.rfqNumber, skippedLines },
          '[rfq] award-bridge: skipped winning lines without skuRef on the source RFQ',
        );
      }
      if (procurementItems.length === 0) {
        logger.warn(
          { rfqNumber: payload.rfqNumber },
          '[rfq] award-bridge: no PO-eligible lines (all lacked skuRef); skipping PO generation',
        );
        return;
      }

      // Resolve the branch's default warehouse — same fallback procurement
      // factory uses for create.
      const flowCtx = buildFlowContext(orgId, actorRef);
      const defaultNode = await flow.repositories.node.getByQuery(
        { isDefault: true },
        { organizationId: orgId, throwOnNotFound: false, lean: true },
      );
      if (!defaultNode) {
        logger.warn({ rfqNumber: payload.rfqNumber }, '[rfq] award-bridge: no default warehouse node');
        return;
      }

      const po = await flow.services.procurement.create(
        {
          vendorRef: payload.vendorId,
          destinationNodeId: String(defaultNode._id),
          items: procurementItems,
        } as Parameters<typeof flow.services.procurement.create>[0],
        flowCtx,
      );

      // Stamp back-ref on the RFQ — kernel emits `order:rfq.po_generated`.
      await rfqRepository.recordPoGenerated(
        payload.rfqNumber,
        {
          poId: String((po as { _id: unknown })._id),
          poNumber: (po as { orderNumber: string }).orderNumber,
        },
        ctx,
      );
    } catch (err) {
      logger.error(
        { err: (err as Error).message, rfqNumber: payload.rfqNumber, vendorId: payload.vendorId },
        '[rfq] award-bridge failed',
      );
    }
  });

  logger.info('[rfq] Award → procurement bridge registered');
}
