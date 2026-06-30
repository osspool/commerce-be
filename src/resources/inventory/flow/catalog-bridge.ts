/**
 * CatalogBridge — connects Flow's SKU resolution to @classytic/catalog.
 *
 * Flow calls `resolveSku(skuRef)` during moves, reservations, and scans.
 * We look up the product via catalog's repository:
 *   1. Variant SKU (variants.sku) — most common for variant products
 *   2. Product _id — for simple products tracked by ObjectId
 *   3. Top-level SKU (identifiers.custom.sku) — for simple products with SKU
 *   4. Permissive fallback — unknown SKU gets a passthrough (tests, inbound receipts)
 */

import type { CatalogBridge, SkuDetails } from '@classytic/flow/domain/contracts';
import type { ShelfLifePolicy } from '@classytic/primitives/shelf-life';
import mongoose from 'mongoose';
import { ensureCatalogEngine } from '#resources/catalog/catalog.engine.js';

const ctx = { actorId: 'flow-bridge', roles: ['admin'] as string[], locale: 'en', currency: 'BDT' };

type TrackedVariant = { tracking?: ShelfLifePolicy; catchWeight?: boolean; weightUom?: string };

/**
 * Map a variant's tracking + catch-weight policy into the fields Flow consumes.
 * `trackingPolicy` is authoritative (drives lot creation + expiry-date
 * derivation); `trackingMode` is kept in sync for back-compat. `catchWeight`
 * flows so Flow captures a measured net weight on received lots (deli/produce).
 * Non-tracked variants resolve to `'none'`.
 */
function trackingFrom(variant: TrackedVariant | undefined): {
  trackingMode: 'none' | 'lot' | 'serial';
  trackingPolicy?: ShelfLifePolicy;
  catchWeight?: boolean;
  weightUom?: string;
} {
  const catchWeight = variant?.catchWeight
    ? { catchWeight: true as const, weightUom: variant.weightUom ?? 'kg' }
    : {};
  const policy = variant?.tracking;
  if (!policy) return { trackingMode: 'none', ...catchWeight };
  return { trackingMode: policy.mode, trackingPolicy: policy, ...catchWeight };
}

const catalogBridge: CatalogBridge = {
  async resolveSku(skuRef: string): Promise<SkuDetails | null> {
    if (!skuRef) return null;

    const catalog = await ensureCatalogEngine();

    // 1. Variant SKU lookup
    const byVariant = await catalog.repositories.product.getByQuery(
      { 'variants.sku': skuRef },
      { ...ctx, throwOnNotFound: false },
    );
    if (byVariant) {
      const variant = byVariant.variants?.find((v) => (v as { sku?: string }).sku === skuRef);
      const variantSku = (variant as { sku?: string } | undefined)?.sku;
      return {
        skuRef,
        sku: variantSku ?? skuRef,
        displayName: variant ? `${byVariant.name} - ${variantSku}` : byVariant.name,
        ...trackingFrom(variant as TrackedVariant | undefined),
        uom: 'unit',
        isActive: byVariant.status === 'active' && (variant as { isActive?: boolean } | undefined)?.isActive !== false,
      };
    }

    // 2. Product _id lookup (simple products)
    if (mongoose.isValidObjectId(skuRef)) {
      try {
        const byId = await catalog.repositories.product.getById(skuRef, { throwOnNotFound: false, ...ctx });
        if (byId) {
          const idents = byId.identifiers as { custom?: { sku?: string } } | undefined;
          // Simple product addressed by _id — carry the tracking policy from
          // its variant (single-variant products keep the policy there).
          const variant = (byId.variants as TrackedVariant[] | undefined)?.find((v) => v.tracking || v.catchWeight);
          return {
            skuRef,
            sku: idents?.custom?.sku ?? skuRef,
            displayName: byId.name,
            ...trackingFrom(variant),
            uom: 'unit',
            isActive: byId.status === 'active',
          };
        }
      } catch {
        // Not found — fall through
      }
    }

    // 3. Top-level SKU lookup via identifiers
    const list = await catalog.repositories.product.findAll(
      { 'identifiers.custom.sku': skuRef },
      { lean: true, limit: 1 },
    );
    const bySku = (list as unknown[])?.[0] as
      | {
          name: string;
          status: string;
          identifiers?: { custom?: { sku?: string } };
          variants?: TrackedVariant[];
        }
      | undefined;
    if (bySku) {
      const variant = bySku.variants?.find((v) => v.tracking || v.catchWeight);
      return {
        skuRef,
        sku: bySku.identifiers?.custom?.sku ?? skuRef,
        displayName: bySku.name,
        ...trackingFrom(variant),
        uom: 'unit',
        isActive: bySku.status === 'active',
      };
    }

    // 4. Permissive fallback — unknown SKU gets a passthrough so inbound
    // receipts/transfers and catalog-less integration tests don't break.
    return {
      skuRef,
      sku: skuRef,
      displayName: skuRef,
      trackingMode: 'none',
      uom: 'unit',
      isActive: true,
    };
  },
};

export default catalogBridge;
