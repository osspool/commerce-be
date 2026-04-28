/**
 * Cost-basis resolution for the COGS pipeline.
 *
 * The catalog can carry cost in two places:
 *   1. The order line snapshot (stamped at placement by `catalog.bridge.ts`)
 *   2. The product itself (`defaultMonetization.costManagement.costPrice` or
 *      legacy top-level `costPrice`)
 *
 * Order line snapshots take precedence — they're frozen at the moment of
 * sale and survive product-level edits — but if a snapshot was written
 * before cost was captured, we fall back to the live product value.
 *
 * When everything resolves to zero, we still allow the COGS post to run
 * with a `costMissing: true` flag so:
 *   - the journal-entry audit trail records that a shipment occurred even
 *     when cost wasn't known (matching Odoo `stock.move._action_done` —
 *     posts zero-value rather than blocking the move);
 *   - admins get a `accounting:cogs.cost_missing` signal listing the
 *     affected lines so finance can backfill cost on the product;
 *   - the inventory-side stock move remains the source of truth.
 *
 * Contrast with ERPNext, which throws "Valuation Rate Missing" by default.
 * Our take: the goods physically left the warehouse — an after-the-fact
 * ledger flag is more useful than a failed shipment.
 */

interface OrderLineLite {
  lineId?: string;
  quantity?: number;
  snapshot?: {
    sku?: string;
    productId?: string;
    offerId?: string;
    name?: string;
    costPrice?: number;
  };
  offerId?: string;
}

export interface AffectedLine {
  lineId?: string;
  sku?: string;
  productId?: string;
  quantity: number;
  source: 'snapshot' | 'product' | 'missing';
}

export interface CostResolution {
  /** Sum of (resolved costPrice × quantity) in paisa. May be 0 when no cost data exists. */
  totalCost: number;
  /** True when at least one line had no cost on snapshot AND no fallback hit. */
  costMissing: boolean;
  /** Per-line provenance — drives the admin "missing cost" view. */
  affectedLines: AffectedLine[];
}

/**
 * Caller-supplied product cost lookup. Bridges pass a real catalog-engine
 * adapter; tests pass a hand-rolled stub. `variantSku` (when provided) lets
 * the lookup hit per-variant cost overrides before falling back to product
 * default. Should return cost in paisa, or null if the product genuinely
 * has no cost recorded.
 */
export type ProductCostLookup = (productId: string, variantSku?: string) => Promise<number | null>;

export async function resolveOrderCost(
  order: Record<string, unknown>,
  lookupProductCost: ProductCostLookup,
): Promise<CostResolution> {
  const lines = (order.lines ?? []) as OrderLineLite[];
  let totalCost = 0;
  let costMissing = false;
  const affectedLines: AffectedLine[] = [];

  for (const line of lines) {
    const qty = line.quantity ?? 1;
    if (qty <= 0) continue;

    const sku = line.snapshot?.sku;
    const productId = line.snapshot?.productId ?? line.snapshot?.offerId ?? line.offerId;
    const snapshotCost = line.snapshot?.costPrice;

    if (typeof snapshotCost === 'number' && snapshotCost > 0) {
      totalCost += snapshotCost * qty;
      affectedLines.push({ lineId: line.lineId, sku, productId, quantity: qty, source: 'snapshot' });
      continue;
    }

    if (productId) {
      const productCost = await lookupProductCost(productId, sku).catch(() => null);
      if (typeof productCost === 'number' && productCost > 0) {
        totalCost += productCost * qty;
        affectedLines.push({ lineId: line.lineId, sku, productId, quantity: qty, source: 'product' });
        continue;
      }
    }

    costMissing = true;
    affectedLines.push({ lineId: line.lineId, sku, productId, quantity: qty, source: 'missing' });
  }

  return { totalCost, costMissing, affectedLines };
}

/**
 * Default product-cost lookup — reads the canonical
 * `defaultMonetization.pricing.costPrice.amount` (Money in paisa, set by
 * `catalog/products/product.costPrice.service.ts`), falling back to the
 * variants[].costPrice on the matching SKU when product-level cost isn't
 * tracked. Returns null when neither is recorded.
 *
 * Lazily imports the catalog engine so unit tests can swap in a stub.
 */
export async function defaultProductCostLookup(
  productId: string,
  variantSku?: string,
): Promise<number | null> {
  const { ensureCatalogEngine } = await import('#resources/catalog/catalog.engine.js');
  const catalog = await ensureCatalogEngine();
  const product = (await catalog.repositories.product.getById(productId, {
    throwOnNotFound: false,
  })) as Record<string, unknown> | null;
  if (!product) return null;

  // Returns paisa. Variants persist costPrice as either a bare number (BDT
  // major, legacy) or a Money object (paisa) — same dual shape that catalog/
  // products/product.costPrice.service.ts writes. Normalize to paisa here
  // so callers always get one unit.
  if (variantSku) {
    const variants = product.variants as Array<Record<string, unknown>> | undefined;
    const variant = variants?.find((v) => (v as { sku?: string }).sku === variantSku);
    const v = variant?.costPrice;
    if (v && typeof v === 'object' && 'amount' in (v as Record<string, unknown>)) {
      const moneyAmt = (v as { amount?: unknown }).amount;
      if (typeof moneyAmt === 'number' && moneyAmt > 0) return moneyAmt;
    }
    if (typeof v === 'number' && v > 0) return Math.round(v * 100);
  }

  // Product-level cost — `defaultMonetization.pricing.costPrice.amount` is
  // already paisa (the catalog cost service writes Math.round(x * 100) here).
  const monetization = product.defaultMonetization as Record<string, unknown> | undefined;
  const pricing = monetization?.pricing as Record<string, unknown> | undefined;
  const moneyAmount = (pricing?.costPrice as { amount?: unknown } | undefined)?.amount;
  if (typeof moneyAmount === 'number' && moneyAmount > 0) return moneyAmount;

  // Legacy top-level field — pre-monetization-block schema, bare BDT number.
  const legacy = product.costPrice as unknown;
  if (typeof legacy === 'number' && legacy > 0) return Math.round(legacy * 100);

  return null;
}
