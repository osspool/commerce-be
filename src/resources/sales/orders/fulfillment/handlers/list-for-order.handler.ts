import { repoOptionsFromCtx } from '@classytic/order';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ensureOrderEngine } from '../../order.engine.js';
import { getFulfillmentContext } from './shared.js';

/**
 * GET /fulfillments/for-order/:orderNumber — list fulfillments for one order.
 *
 * Response shape follows the be-prod list convention (matches my-orders,
 * order-events, cart, stock-request, inventory): spread mongokit's pagination
 * result at the top level so `data` is a sibling of `success`, not nested.
 * That's what arc-next's `extractItems` looks for — wrapping in another `data`
 * silently nets zero items in `useListQuery` consumers.
 */
export async function listFulfillmentsForOrderHandler(req: FastifyRequest, reply: FastifyReply) {
  const engine = await ensureOrderEngine();
  const { orderNumber } = req.params as { orderNumber: string };
  const ctx = getFulfillmentContext(req);
  const result = await engine.repositories.fulfillment.getAll({
    filters: { orderNumber },
    sort: { createdAt: -1 },
    ...repoOptionsFromCtx(ctx),
  });
  // mongokit `getAll` returns either a bare array (when no pagination
  // params) or an `Offset/KeysetPaginationResult` carrying `{ data, total,
  // page, limit, ... }`. Normalise to the convention shape so the wire
  // response always exposes `data` at the top level.
  const payload: Record<string, unknown> = Array.isArray(result)
    ? { data: result }
    : (result as unknown as Record<string, unknown>);
  return reply.send(payload);
}
