import mongoose from 'mongoose';
import { type CogsData, cogsToPosting } from '../../posting/contracts/inventory.contract.js';
import { definePostingHandler } from '../define-posting-handler.js';
import { OrderFulfilledEvent, orderFulfilledSchema } from '../event-definitions.js';

/**
 * Posts the COGS journal entry when an order ships.
 *
 * The bridge (`lifecycle/handlers/ledger-cogs-bridge.ts`) resolves the cost
 * basis using the snapshot → product fallback chain and stamps it on the
 * event payload. This handler stays a pure poster — same shape as
 * `return-restocked.handler.ts`.
 *
 * Always posts, even when `costAmount === 0`. A zero-value entry is the
 * Odoo `stock.move._action_done` pattern: the inventory move is the source
 * of truth; the journal entry exists to make the audit trail complete. The
 * `costMissing` flag + `affectedLines` go onto `entryData.metadata` so the
 * admin "missing cost" view can list these and finance can backfill cost
 * on the product, then re-trigger the post.
 *
 * Legacy fallback: if the event arrives without `costAmount` / `branchId`
 * (older publishers, replay from disk), we resolve them from the order doc
 * directly so the handler is forgiving of payload-shape drift.
 */
export const orderFulfilledHandler = definePostingHandler({
  event: OrderFulfilledEvent,
  payloadSchema: orderFulfilledSchema,

  async build(payload, log) {
    const db = mongoose.connection.db;
    if (!db) return null;

    let branchId = payload.branchId;
    let costAmount = payload.costAmount;
    let costMissing = payload.costMissing;
    let affectedLines = payload.affectedLines;
    let orderDate: Date | undefined;
    // Order's human-readable reference (e.g. ORD-2026-04-1234) — used as
    // the JE label so the GL doesn't show raw 24-char ObjectIds.
    let orderReferenceNumber: string | undefined;

    // Lookup serves two purposes: legacy fallback (when bridge didn't
    // pre-resolve costAmount/branchId) AND fetching the human-readable
    // referenceNumber for the JE label. Always done — the cost is one
    // lean projection round-trip and pays for itself in display quality.
    {
      const order = await db
        .collection('orders')
        .findOne(
          { _id: new mongoose.Types.ObjectId(payload.orderId) },
          { projection: { lines: 1, branch: 1, organizationId: 1, createdAt: 1, referenceNumber: 1 } },
        );
      if (!order) {
        log.warn({ orderId: payload.orderId }, 'COGS post: order not found');
        return null;
      }
      orderDate = (order.createdAt as Date | undefined) ?? new Date();
      orderReferenceNumber = (order.referenceNumber as string | undefined) ?? undefined;
      if (branchId === undefined) {
        branchId =
          (order.organizationId as { toString: () => string } | undefined)?.toString() ??
          (order.branch as { toString: () => string } | undefined)?.toString();
      }
      if (costAmount === undefined) {
        const lines = (order.lines as Array<{ snapshot?: { costPrice?: number }; quantity?: number }> | undefined) ?? [];
        costAmount = lines.reduce((s, l) => s + (l.snapshot?.costPrice ?? 0) * (l.quantity ?? 1), 0);
        if (costAmount === 0) costMissing = true;
      }
    }

    if (!branchId) {
      log.warn({ orderId: payload.orderId }, 'COGS post: no branch resolved, skipping');
      return null;
    }

    const data: CogsData = {
      orderId: payload.orderId,
      orderReferenceNumber,
      costAmount: costAmount ?? 0,
      date: orderDate ?? new Date(),
      ...(costMissing
        ? {
            metadata: {
              costMissing: true,
              ...(affectedLines ? { affectedLines } : {}),
            },
          }
        : {}),
    };

    return {
      branchId,
      posting: cogsToPosting(data),
      logFields: { orderId: payload.orderId, costAmount: data.costAmount, costMissing: !!costMissing },
      successMessage: costMissing
        ? 'COGS journal entry created (zero-value, costMissing flag set)'
        : 'COGS journal entry created',
    };
  },
});
