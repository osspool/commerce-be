import { type CogsReversalData, cogsReversalToPosting } from '../../posting/contracts/inventory.contract.js';
import { definePostingHandler } from '../define-posting-handler.js';
import { ReturnRestockedEvent, returnRestockedSchema } from '../event-definitions.js';

/**
 * Posts the COGS reversal when a refunded order's items go back into
 * stock — `Dr 1165 Inventory | Cr 5111 COGS` for `costPrice × qty`.
 *
 * The bridge (`lifecycle/handlers/ledger-restock-bridge.ts`) does the
 * cost resolution; this handler is a pure poster. Always posts, even at
 * zero — the bridge stamps `costMissing: true` + `affectedLines` so the
 * audit trail records the restock and the admin "missing cost" view picks
 * it up.
 *
 * Idempotency lives at the posting layer (`cogs-reversal-${returnId}`) —
 * re-emitting for the same return is a no-op.
 */
export const returnRestockedHandler = definePostingHandler({
  event: ReturnRestockedEvent,
  payloadSchema: returnRestockedSchema,

  async build(payload, log) {
    if (!payload.returnId || !payload.orderId) return null;
    if (!payload.branchId) {
      log.warn({ returnId: payload.returnId }, 'return.restocked missing branchId — skipping');
      return null;
    }

    const data: CogsReversalData = {
      returnId: payload.returnId,
      orderId: payload.orderId,
      costAmount: payload.costAmount,
      date: payload.date ? new Date(payload.date) : new Date(),
      description: payload.description,
      ...(payload.costMissing
        ? {
            metadata: {
              costMissing: true,
              ...(payload.affectedLines ? { affectedLines: payload.affectedLines } : {}),
            },
          }
        : {}),
    };

    return {
      branchId: payload.branchId,
      posting: cogsReversalToPosting(data),
      logFields: {
        returnId: payload.returnId,
        orderId: payload.orderId,
        costAmount: payload.costAmount,
        costMissing: !!payload.costMissing,
      },
      successMessage: payload.costMissing
        ? 'COGS reversal entry created (zero-value, costMissing flag set)'
        : 'COGS reversal journal entry created (Dr Inventory | Cr COGS)',
    };
  },
});
