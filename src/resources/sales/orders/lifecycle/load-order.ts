/**
 * Tiny shared helper used by every lifecycle handler that needs to read the
 * order doc to act on it. Encapsulates the `getByQuery` shape so a future
 * tenancy / lookup change is a single edit, and so handler unit tests can
 * stub by replacing `engine.repositories.order.getByQuery` (no need to
 * mock this helper itself).
 */

import type { OrderEngine } from '@classytic/order';

interface OrderRepoLike {
  getByQuery: (
    f: Record<string, unknown>,
    o?: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null>;
}

export async function loadOrderByNumber(
  engine: OrderEngine,
  orderNumber: string,
): Promise<Record<string, unknown> | null> {
  const repo = engine.repositories.order as unknown as OrderRepoLike;
  return repo.getByQuery({ orderNumber }, { throwOnNotFound: false, lean: true });
}
