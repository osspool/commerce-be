/**
 * Order channel taxonomy — single source of truth.
 *
 * Each channel has two real consequences in be-prod:
 *   - payment timing  (immediate-capture vs intent / pending)
 *   - stock timing    (decrement-at-create vs decrement-at-ship)
 *
 * Goods-leave-on-sale channels (POS in-store) MUST decrement stock at the
 * moment the order is created, because the customer walks out with the
 * goods. Ship-later channels (web / marketplace) reserve at order time and
 * decrement only when the fulfillment transitions to `shipped`.
 *
 * Keep this the canonical list — do not add channel strings inline in
 * handlers. Add to `CHANNELS` and, if applicable, to `GOODS_LEAVE_ON_SALE`.
 */

export const CHANNELS = ['pos', 'web', 'marketplace', 'phone', 'b2b', 'api'] as const;

export type OrderChannel = (typeof CHANNELS)[number];

/**
 * Channels where the customer takes possession of the goods at order time,
 * so stock decrements immediately (no later `ship` step).
 */
export const GOODS_LEAVE_ON_SALE: readonly OrderChannel[] = ['pos'] as const;

export function isGoodsLeaveOnSaleChannel(channel: unknown): boolean {
  return typeof channel === 'string' && (GOODS_LEAVE_ON_SALE as readonly string[]).includes(channel);
}
