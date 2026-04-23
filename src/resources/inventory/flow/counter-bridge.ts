/**
 * Counter Bridge
 *
 * Provides the same `nextSeq(prefix, scope)` API that the old InventoryCounter had,
 * backed by Flow's Counter model. This bridges the gap so purchase, transfer,
 * supplier, and stock-request models can generate document numbers without
 * depending on the deleted stock/models/ directory.
 */
import { getNextSequence } from '@classytic/flow/models';
import { getFlowEngine } from './flow-engine.js';

/**
 * Sentinel "cross-org" scope for document sequences that span all orgs
 * (purchase invoices, transfers). Flow's Counter model stores
 * `organizationId` as an ObjectId (via `injectTenantField`), so the zero
 * ObjectId string casts cleanly and will never collide with a real
 * Better Auth org id.
 */
const SYSTEM_ORG_SENTINEL = '000000000000000000000000';

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
    return getNextSequence(flow.models.Counter, SYSTEM_ORG_SENTINEL, compoundPrefix);
  },
};
