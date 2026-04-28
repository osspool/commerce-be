/**
 * Helpers shared by lifecycle handlers. Kept in a leading-underscore file so
 * it's obviously not a public handler module — handler files name themselves
 * by what they do (`stock-commit.ts`, `ledger-cogs-bridge.ts`, ...) and only
 * import from `_shared` for line/disposition / id utilities that would
 * otherwise be duplicated across them.
 */

export interface ReservationRef {
  lineId: string;
  skuRef: string;
  quantity: number;
  reservationId?: string;
}

interface OrderLineLite {
  lineId?: string;
  quantity?: number;
  snapshot?: { sku?: string; productId?: string; name?: string; costPrice?: number };
  offerId?: string;
}

/**
 * Resolve which units to move when a transition fires. Prefers the
 * canonical reservation refs stamped at placement (they carry the resolved
 * `skuRef` the warehouse actually held against), falling back to walking
 * the order's `lines[]` so the handler still works for orders created
 * outside the placement pipeline (legacy admin imports, future channels).
 */
export function pickStockLines(order: Record<string, unknown>): ReservationRef[] {
  const meta = order.metadata as { reservationRefs?: ReservationRef[] } | undefined;
  if (meta?.reservationRefs?.length) {
    return meta.reservationRefs.filter((r) => r.skuRef && r.quantity > 0);
  }
  const lines = (order.lines ?? []) as OrderLineLite[];
  return lines
    .map<ReservationRef | null>((line) => {
      const skuRef = line.snapshot?.sku ?? line.offerId;
      if (!skuRef || !line.quantity || line.quantity <= 0) return null;
      return { lineId: line.lineId ?? '', skuRef, quantity: line.quantity };
    })
    .filter((r): r is ReservationRef => r !== null);
}

export function stringifyOrgId(id: unknown): string | null {
  if (!id) return null;
  if (typeof id === 'string') return id;
  const asObj = id as { toString?: () => string };
  if (typeof asObj.toString === 'function') return asObj.toString();
  return null;
}

export interface ReturnDispositionInput {
  reason?: string;
  disposition?: 'restock' | 'defective' | 'damaged' | 'write_off';
}

/**
 * Decide where returned units land. Explicit `disposition` wins; otherwise
 * the transition reason is regex-sniffed for defect / damage hints. Anything
 * else restocks.
 */
export function isWriteOffDisposition(input: ReturnDispositionInput): boolean {
  if (
    input.disposition === 'defective' ||
    input.disposition === 'damaged' ||
    input.disposition === 'write_off'
  ) {
    return true;
  }
  return /defect|damag|brok|write.?off/i.test(input.reason ?? '');
}

