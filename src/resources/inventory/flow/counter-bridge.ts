/**
 * Counter Bridge
 *
 * Provides the same `nextSeq(prefix, scope)` API that the old InventoryCounter had,
 * backed by Flow's Counter model. This bridges the gap so purchase, transfer,
 * supplier, and stock-request models can generate document numbers without
 * depending on the deleted stock/models/ directory.
 */
import { getFlowEngine } from './flow-engine.js';

/**
 * InventoryCounter bridge — drop-in replacement for the deleted model.
 *
 * Usage (same as the old pattern):
 * ```ts
 * import { InventoryCounter } from '../flow/counter-bridge.js';
 * const seq = await InventoryCounter.nextSeq('PINV', yearMonth);
 * ```
 */
export const InventoryCounter = {
  /**
   * Atomically get the next sequence number for a given prefix + scope.
   */
  async nextSeq(prefix: string, scope: string): Promise<number> {
    const flow = getFlowEngine();
    const compoundPrefix = `${prefix}-${scope}`;
    // Flow's counter is org-scoped — use a global org key for document numbering
    // since these are cross-org business documents (purchase invoices, transfers, etc.)
    const doc = await flow.models.Counter.findOneAndUpdate(
      { organizationId: '__system__', prefix: compoundPrefix },
      { $inc: { currentValue: 1 } },
      { returnDocument: 'after', upsert: true },
    );
    return doc?.currentValue as number;
  },
};
