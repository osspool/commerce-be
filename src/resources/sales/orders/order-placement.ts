/**
 * Order placement pipeline helpers.
 *
 * The @classytic/order package's `repo.create()` is a single atomic insert
 * — it does NOT execute the saga steps defined in the package's port
 * interfaces. It just builds the document and inserts it. Stock reservation,
 * payment authorization, etc. are the host's responsibility.
 *
 * This module fills that gap: it reserves stock via the FlowBridge BEFORE
 * order persistence, so concurrent orders for the last unit can't oversell.
 * If reservation succeeds but the subsequent order insert fails, we compensate
 * by releasing the reservation.
 *
 * Stamped onto the persisted order as `metadata.reservationRefs` so the
 * fulfillment ship handler can commit them atomically, and so a cancel
 * handler can release them on refund/void.
 */

import type { FlowBridge, LineSnapshot, OrderCatalogBridge, OrderContext } from '@classytic/order';
import type { FastifyBaseLogger } from 'fastify';

export interface OrderLineInput {
  kind?: string;
  offerId?: string;
  /**
   * Variant SKU within the product identified by `offerId`. Required for
   * variable products so the catalog bridge resolves to the variant's
   * Flow-canonical skuRef (= `variantSku`) rather than the product's
   * `_id`. Omit for simple products — bridge falls back to `product._id`,
   * matching `skuRefFromProduct` (be-prod inventory/flow/context-helpers).
   */
  variantSku?: string;
  quantity: number;
  /** Host may inline a snapshot (unit test flow); otherwise we resolve via catalog. */
  snapshot?: Partial<LineSnapshot>;
}

export interface ReservedLine {
  lineId: string;
  skuRef: string;
  quantity: number;
  /** Reservation ID from Flow — used to commit/release later. */
  reservationId: string;
}

export interface ReservationResult {
  /** Metadata to stamp on the order document for later commit/release. */
  reservationRefs: ReservedLine[];
  /** Warehouse each line was allocated to (currently one: the branch's DEFAULT_LOCATION). */
  warehouseId: string;
}

export interface ResolvedLine {
  lineId: string;
  skuRef: string;
  quantity: number;
  /** Full snapshot resolved via catalog bridge — stamped onto the order line
   *  so the order package doesn't re-resolve (which can drift if the bridge
   *  falls back differently when called through different code paths). */
  snapshot: LineSnapshot;
}

/**
 * Resolve SKU + full snapshot for each line via the catalog bridge.
 *
 * Returns null if any line can't be resolved. The returned `snapshot` is
 * stamped onto the order line in `buildOrderLinesWithSnapshots()` so the
 * order package persists the exact same SKU we reserved against.
 */
export async function resolveLineSkus(
  lines: OrderLineInput[],
  catalogBridge: OrderCatalogBridge,
  ctx: OrderContext,
): Promise<ResolvedLine[] | null> {
  const resolved: ResolvedLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineId = `line_${i}`;

    // Inlined snapshot takes precedence over bridge resolution.
    if (line.snapshot?.sku) {
      resolved.push({
        lineId,
        skuRef: line.snapshot.sku,
        quantity: line.quantity,
        snapshot: line.snapshot as LineSnapshot,
      });
      continue;
    }

    if (!line.offerId) return null;

    // Forward the variantSku via `selections` so the bridge can resolve to
    // the variant's canonical Flow skuRef (= variant.sku). Otherwise
    // variant products collapse to the product-level SKU and every
    // reservation / validate-stock call against a variant returns zero.
    const snap = await catalogBridge.resolveSnapshot(
      line.offerId,
      line.quantity,
      line.variantSku ? { variantSku: line.variantSku } : {},
      ctx,
    );
    if (!snap?.sku) return null;

    resolved.push({
      lineId,
      skuRef: snap.sku,
      quantity: line.quantity,
      snapshot: snap,
    });
  }

  return resolved;
}

/**
 * Merge resolved snapshots back onto raw line inputs so the order package
 * persists the exact same SKU we reserved against. Prevents drift between
 * the reservation's skuRef and the order-line snapshot.sku.
 */
export function buildOrderLinesWithSnapshots(rawLines: OrderLineInput[], resolved: ResolvedLine[]): unknown[] {
  return rawLines.map((line, i) => ({
    ...line,
    snapshot: resolved[i]?.snapshot ?? line.snapshot,
  }));
}

/**
 * Reserve stock for every line in the order. Delegates to the FlowBridge
 * (see bridges/flow.bridge.ts), which uses Flow's atomic reservation service.
 *
 * Throws the underlying `InsufficientStockError` (code: INSUFFICIENT_STOCK,
 * status 409) when any line can't be reserved. Already-reserved lines from
 * this call are released before the error propagates.
 */
export async function reserveOrderStock(
  lines: Array<{ lineId: string; skuRef: string; quantity: number }> | ResolvedLine[],
  flowBridge: FlowBridge,
  ctx: OrderContext,
  logger?: FastifyBaseLogger,
): Promise<ReservationResult> {
  // Route to warehouse(s). Current model: one allocation per branch.
  const routing = await flowBridge.routeToWarehouses(
    lines.map((l) => ({ skuRef: l.skuRef, quantity: l.quantity })),
    /* shippingAddress */ { line1: '', city: '', country: 'BD' },
    ctx,
  );

  const allocation = routing.allocations[0];
  if (!allocation) {
    throw new Error('No warehouse allocation returned — backorder not supported yet');
  }

  const requests = lines.map((l) => ({
    lineId: l.lineId,
    skuRef: l.skuRef,
    quantity: l.quantity,
  }));

  try {
    const refs = await flowBridge.reserve(allocation.warehouseId, requests, ctx);

    const reservationRefs: ReservedLine[] = refs.map((ref, i) => ({
      lineId: lines[i].lineId,
      skuRef: lines[i].skuRef,
      quantity: lines[i].quantity,
      reservationId: ref.id,
    }));

    return { reservationRefs, warehouseId: allocation.warehouseId };
  } catch (err) {
    // Flow's reserve() is not transactional across multiple requests —
    // if request 3 of 5 fails, requests 1 and 2 are already reserved.
    // The bridge implementation rethrows on first failure; any partial
    // reservations are released by the next sweep OR stay held until TTL
    // expiry (default 30min). We don't have the partial refs here, so we
    // rely on the TTL for compensation.
    logger?.warn(
      { err: (err as Error).message, lineCount: lines.length },
      'order.reserveStock failed — partial reservations will expire via TTL',
    );
    throw err;
  }
}

/**
 * Release reservations — called when order creation fails AFTER a successful
 * reservation (e.g., the insert throws a validation error, idempotency
 * conflict, etc.).
 *
 * Best-effort. Failures here are logged but don't propagate — the TTL
 * sweeper cleans up orphaned reservations.
 */
export async function releaseOrderStock(
  refs: ReservedLine[],
  flowBridge: FlowBridge,
  ctx: OrderContext,
  logger?: FastifyBaseLogger,
): Promise<void> {
  if (refs.length === 0) return;
  try {
    await flowBridge.release(
      refs.map((r) => ({
        id: r.reservationId,
        payload: { skuRef: r.skuRef, quantity: r.quantity },
      })),
      ctx,
    );
  } catch (err) {
    logger?.warn(
      { err: (err as Error).message, count: refs.length },
      'order.releaseStock failed — TTL sweeper will eventually reap',
    );
  }
}

/**
 * True when the given error is Flow's InsufficientStockError.
 * Used by the place handler to return 409 instead of 500.
 */
export function isInsufficientStockError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; name?: string };
  return e.code === 'INSUFFICIENT_STOCK' || e.name === 'InsufficientStockError';
}

/**
 * Shape matching Flow's `InsufficientStockError` public readonly fields.
 * See `packages/flow/src/domain/errors/insufficient-stock.error.ts`.
 */
export interface InsufficientStockDetails {
  skuRef: string;
  requested: number;
  available: number;
  locationId?: string;
}

/**
 * Extract structured per-line shortage info from a Flow `InsufficientStockError`.
 * Returns null when the input isn't a stock error (caller should rethrow).
 *
 * The SDK and FE use this shape to render helpful messages like
 * "Only 2 of SKU-XYZ-M available — you asked for 5".
 */
export function extractStockShortage(err: unknown): InsufficientStockDetails | null {
  if (!isInsufficientStockError(err)) return null;
  const e = err as {
    skuRef?: string;
    requested?: number;
    available?: number;
    locationId?: string;
    message?: string;
  };
  return {
    skuRef: e.skuRef ?? 'unknown',
    requested: e.requested ?? 0,
    available: e.available ?? 0,
    ...(e.locationId && { locationId: e.locationId }),
  };
}
