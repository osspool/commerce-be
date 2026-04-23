/**
 * Catalog bridge — @classytic/catalog adapter for the invoice engine.
 *
 * Resolves a productId to enriched line metadata (name, skuRef, hsCode, uom,
 * defaultPrice) so invoice lines can be auto-enriched when the caller passes
 * a bare `productId`. The engine uses this only when it's wired; callers that
 * pass a full line (name + unitPrice + etc.) are unaffected.
 *
 * See `packages/invoice/src/domain/contracts/catalog-bridge.ts` for the port.
 */

import type { CatalogBridge, CatalogProduct } from '@classytic/invoice/domain/contracts';
import { ensureCatalogEngine } from '#resources/catalog/catalog.engine.js';

export function createCatalogBridgeForInvoice(): CatalogBridge {
  return {
    async resolveProduct(productId: string): Promise<CatalogProduct | null> {
      const catalog = await ensureCatalogEngine();

      const product = await catalog.repositories.product.getById(productId, {
        throwOnNotFound: false,
        actorId: 'invoice-catalog-bridge',
        roles: ['admin'],
        locale: 'en',
        currency: 'BDT',
      });
      if (!product) return null;

      const p = product as unknown as Record<string, unknown>;
      const identifiers = p.identifiers as Record<string, unknown> | undefined;
      const custom = identifiers?.custom as Record<string, unknown> | undefined;
      const monetization = p.defaultMonetization as Record<string, unknown> | undefined;
      const pricing = monetization?.pricing as Record<string, unknown> | undefined;
      const basePrice = pricing?.basePrice as { amount: number } | undefined;
      const compliance = p.compliance as Record<string, unknown> | undefined;

      return {
        productId: String(product._id),
        name: (p.name as string) ?? 'Unknown',
        skuRef: (custom?.sku as string) ?? String(product._id),
        hsCode: (compliance?.hsCode as string) ?? undefined,
        uom: (p.uom as string) ?? 'pcs',
        defaultPrice: basePrice?.amount,
      };
    },
  };
}
