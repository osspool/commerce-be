/**
 * Cart engine init plugin — registered in app.ts bootstrap[].
 *
 * Same pattern as inventoryInit, loyaltyInit, promoInit. Boots the
 * @classytic/cart engine before resources load so the cart resource
 * can import the singleton.
 */
import type { FastifyInstance } from 'fastify';
import { initCartEngine } from './cart.engine.js';

export default async function cartInit(fastify: FastifyInstance) {
  const engine = await initCartEngine();
  fastify.log.info({ kinds: engine.kinds.list(), mode: engine.mode }, 'Cart engine initialized');
}
