/**
 * Helpers shared by lifecycle handlers. Kept in a leading-underscore file so
 * it's obviously not a public handler module — handler files name themselves
 * by what they do (`stock-commit.ts`, `ledger-cogs-bridge.ts`, ...) and only
 * import from `_shared` for line/disposition / id utilities that would
 * otherwise be duplicated across them.
 *
 * ## OrderChange.metadata schema
 *
 * The kernel persists `metadata` as `Schema.Types.Mixed`. Multiple lifecycle
 * subscribers stamp fields on it concurrently (each one its own concern,
 * each one idempotent). The `OrderChangeMetadata` type below is the
 * union-of-everything-anyone-stamps. Treat fields as optional — at any
 * point in time only a subset is present, depending on which handlers have
 * fired. Reading a field that hasn't been stamped yet means "the side-effect
 * hasn't happened" (idempotency-stamp pattern).
 */

// ─── Disposition primitives ─────────────────────────────────────────────────

/**
 * Per-line outcome decided at RMA-create time (or, when inspection is
 * required, at inspect time). Drives both stock destination and JE class:
 *   - `restock` → DEFAULT location, COGS reversal JE
 *   - `damaged | defective | scrap | write_off` → ADJUSTMENT location,
 *      inventory-loss JE (NOT COGS reversal — original COGS stands)
 */
export type Disposition = 'restock' | 'damaged' | 'defective' | 'scrap' | 'write_off';

export const VALID_DISPOSITIONS: ReadonlySet<Disposition> = new Set([
  'restock',
  'damaged',
  'defective',
  'scrap',
  'write_off',
]);

export function isWriteOffValue(d: Disposition | string): boolean {
  return d === 'damaged' || d === 'defective' || d === 'scrap' || d === 'write_off';
}

/**
 * Resolved per-action route: `kind` drives stock + ledger branching;
 * `tag` is the raw disposition for audit logs / metadata stamps.
 */
export interface DispositionRouting {
  kind: 'restock' | 'write_off';
  tag: string;
}

/**
 * Build a per-action disposition resolver that walks the priority chain:
 *   1. `metadata.dispositions[i]` — array aligned with `actions[]`
 *   2. `metadata.disposition` — change-level fallback applied uniformly
 *   3. Reason regex — legacy heuristic (matches `isWriteOffDisposition`)
 *
 * Same chain used by `change-confirmed-stock-return.ts` (route goods) and
 * `change-confirmed-ledger-restock-bridge.ts` (route ledger). DRYing here
 * prevents drift if the policy changes (e.g. add a `pending_inspection`
 * value or a customer-group-specific default).
 */
export function buildDispositionResolver(
  meta: Pick<OrderChangeMetadata, 'dispositions' | 'disposition'>,
  changeReason: string | undefined,
): (i: number) => DispositionRouting {
  const perLineArray = meta.dispositions ?? [];
  const changeLevelDisposition = meta.disposition;
  const reasonFallbackIsWriteOff = isWriteOffDisposition({ reason: changeReason ?? '' });
  return (i: number): DispositionRouting => {
    const raw =
      (perLineArray[i] as string | null | undefined)
      ?? changeLevelDisposition
      ?? (reasonFallbackIsWriteOff ? 'defective' : 'restock');
    return { kind: isWriteOffValue(raw) ? 'write_off' : 'restock', tag: raw };
  };
}

// ─── OrderChange.metadata typed shape ───────────────────────────────────────

/**
 * Union of every field any RMA lifecycle handler / service may stamp on
 * `OrderChange.metadata`. Each handler reads/writes a small subset; the
 * presence of an idempotency stamp (e.g. `cogsReversedAt`) means "this
 * handler's side-effect has run". Optional throughout because at any
 * moment only a subset is populated.
 *
 * Stamps prefixed `_` are diagnostic/internal (e.g. error trace fields).
 */
export interface OrderChangeMetadata {
  // ── Authoring intent (set at RMA create time by admin/customer handler)
  /** Per-action dispositions ordered to match `actions[]`. */
  dispositions?: (Disposition | null)[];
  /** Change-level fallback applied to every action without an explicit value. */
  disposition?: Disposition;
  /** Opt-in QC inspection step: confirm parks goods at HOLDING + defers ledger. */
  requireInspection?: boolean;
  /** Original payment method, set at order placement. */
  paymentGateway?: string;
  /** Customer-vs-admin actor stamp (kernel writes on requestChange). */
  initiatedBy?: 'customer' | 'admin' | 'system';

  // ── Stock-return handler (`change-confirmed-stock-return.ts`)
  stockReturnedAt?: Date;
  stockReturnedQuantity?: number;
  inspectionStatus?: 'pending' | 'passed' | 'mixed' | 'failed';
  inspectionGroupId?: string;

  // ── Ledger handler (`change-confirmed-ledger-restock-bridge.ts`)
  cogsReversedAt?: Date;
  cogsReversedAmount?: number;
  writeOffAmount?: number;

  // ── Restocking-fee handler (`change-confirmed-restocking-fee.ts`)
  restockingFeePostedAt?: Date;
  restockingFeeAmount?: number;

  // ── Exchange-replacement handler (`change-confirmed-exchange-replacement.ts`)
  replacementOrderId?: string;
  replacementOrderNumber?: string;
  replacementCreatedAt?: Date;
  replacementProductId?: string;
  replacementProductName?: string;
  replacementQuantity?: number;
  replacementError?: string;
  replacementErrorAt?: Date;

  // ── Inspect service (`services/rma-inspect.service.ts`)
  inspectedAt?: Date;
  inspectedBy?: string;
  inspectionNotes?: string;

  // ── Refund handler (`change-confirmed-refund.ts`)
  refundProcessedAt?: Date;
  refundedAmount?: number;
  refundSkipReason?: string;

  // ── Decline path (set by kernel `decline()`)
  declineReason?: string;

  // Allow forward-compat extension without TypeScript errors. Handlers
  // should still prefer typed fields above when reading.
  [k: string]: unknown;
}

// ─── Reservation refs ──────────────────────────────────────────────────────

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

