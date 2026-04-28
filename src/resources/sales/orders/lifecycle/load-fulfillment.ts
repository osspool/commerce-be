/**
 * Helper for lifecycle handlers that subscribe to fulfillment FSM events.
 *
 * The order package emits `{ fulfillmentNumber, orderNumber, fromStatus,
 * toStatus }` on every transition — handlers that need the full doc to
 * decide on inventory / accounting side-effects pull both the fulfillment
 * and its parent order through this tiny pair so the access pattern is
 * uniform across handlers (and trivially stubbed in tests).
 */

import type { OrderEngine } from '@classytic/order';

interface RepoLike {
  getByQuery: (
    f: Record<string, unknown>,
    o?: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null>;
}

export async function loadFulfillmentByNumber(
  engine: OrderEngine,
  fulfillmentNumber: string,
): Promise<Record<string, unknown> | null> {
  const repo = engine.repositories.fulfillment as unknown as RepoLike;
  return repo.getByQuery(
    { fulfillmentNumber },
    { throwOnNotFound: false, lean: true },
  );
}
