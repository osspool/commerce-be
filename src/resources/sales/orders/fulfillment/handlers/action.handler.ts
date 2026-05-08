/**
 * POST /fulfillments/:id/action — FSM-validated transition.
 *
 * Pure FSM dispatch: validate the verb, transition the doc, return.
 * Inventory + accounting side-effects (stock decrement on `shipped`,
 * COGS journal posting) are handled by the lifecycle event subscribers
 * registered through
 * `resources/sales/orders/lifecycle/wire-handlers.ts`. They listen for
 * `order:fulfillment.transition` and act when the transition is the one
 * they care about. This route stays thin and uniform across every
 * fulfillment type — `physical`, `subscription`, `course-grant`, future
 * digital handlers — so adding a new fulfillment type doesn't require
 * weaving inventory hooks into the HTTP handler.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { ensureOrderEngine } from '../../order.engine.js';
import { type FulfillmentLike, getFulfillmentContext } from './shared.js';

const statusMap: Record<string, string> = {
  ship: 'shipped',
  deliver: 'delivered',
  cancel: 'canceled',
  pick: 'picking',
  pack: 'packed',
  dispatch: 'dispatched',
  check_in: 'checked_in',
  grant: 'granted',
  complete: 'completed',
  activate: 'active',
  renew: 'renewing',
  expire: 'expired',
  accept: 'accepted',
  prepare: 'preparing',
  assign: 'assigned',
  start: 'in_progress',
  // Manual handler — own-driver / no-courier delivery. The pending →
  // out_for_delivery transition is the manual analog of `ship` (goods
  // leave our possession), so the kernel's coverage-commit fix bumps
  // `line.fulfilledQuantity` here too.
  send_out: 'out_for_delivery',
};

export async function fulfillmentActionHandler(req: FastifyRequest, reply: FastifyReply) {
  const engine = await ensureOrderEngine();
  const { id } = req.params as { id: string };
  const { action } = req.body as { action: string };
  const ctx = getFulfillmentContext(req);
  const targetState = statusMap[action] ?? action;
  const fulfillment = (await engine.repositories.fulfillment.transition(id, targetState, ctx)) as FulfillmentLike;

  return reply.send(fulfillment);
}
