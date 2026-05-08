/**
 * Product route handlers — catalog-backed.
 *
 * Each function is a Fastify raw handler imported by product.resource.ts.
 * Business logic delegated to catalog engine services.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { ensureCatalogEngine } from '#resources/catalog/catalog.engine.js';
import {
  buildHeadOfficeFlowContext,
  DEFAULT_LOCATION,
} from '#resources/inventory/flow/context-helpers.js';
import { getFlowEngineOrNull } from '#resources/inventory/flow/flow-engine.js';
import { NotFoundError } from '@classytic/arc/utils';

function catalogCtx(req: FastifyRequest) {
  return {
    actorId: (req as unknown as { user?: { id?: string } }).user?.id ?? 'anonymous',
    roles: ['admin'] as string[],
    locale: 'en',
    currency: 'BDT',
  };
}

/** GET /products/slug/:slug */
export async function getBySlug(req: FastifyRequest, reply: FastifyReply) {
  const { slug } = req.params as { slug: string };
  const catalog = await ensureCatalogEngine();
  const product = await catalog.repositories.product.getByQuery(
    { slug },
    { ...catalogCtx(req), throwOnNotFound: false },
  );
  if (!product) {
    throw new NotFoundError('Product not found');
  }
  return reply.send(product);
}

/** GET /products/:productId/recommendations */
export async function getRecommendations(req: FastifyRequest, reply: FastifyReply) {
  const { productId } = req.params as { productId: string };
  const catalog = await ensureCatalogEngine();
  try {
    const related = await catalog.utilities.query.getRelated(productId, 'related', catalogCtx(req), { limit: 4 });
    return reply.send(related);
  } catch {
    return reply.send([]);
  }
}

/**
 * POST /products/:id/sync-stock
 *
 * Manually rebuild the storefront's `stockProjection` cache for one
 * product. Reads on-hand from the **head-office** branch and writes a
 * new projection.
 *
 * This route exists as an admin emergency button — the normal happy
 * path is the event-driven auto-sync registered in
 * [resources/inventory/inventory.handlers.ts](../../inventory/inventory.handlers.ts)
 * which fires on `flow.move.done` / `flow.reservation.released` /
 * `flow.reservation.consumed` / `flow.adjustment.posted` /
 * `flow.procurement.received`. Use this route only when you suspect
 * the cache has drifted and want to force a re-read.
 *
 * **Branch context is HO, not the caller's active branch.** Routing
 * the read through the caller's branch (the previous behavior) caused
 * a "last-sync-wins" cache-corruption bug: a manager syncing from
 * MAIN's dashboard would overwrite the public storefront's HO figure
 * with sub-branch stock. The single shared cache must reflect a
 * single canonical branch — head-office, where online orders fulfill.
 */
export async function syncStock(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const catalog = await ensureCatalogEngine();
  const ctx = catalogCtx(req);

  const product = await catalog.repositories.product.getById(id, ctx);
  if (!product) {
    throw new NotFoundError('Product not found');
  }

  const flow = getFlowEngineOrNull();
  if (!flow) {
    return reply.send({ productId: id, totalQuantity: 0, synced: false, errors: ['Flow engine not available'] });
  }

  const flowCtx = await buildHeadOfficeFlowContext('stock-sync');
  if (!flowCtx) {
    return reply.send({
      productId: id,
      totalQuantity: 0,
      synced: false,
      errors: ['No head-office branch configured — storefront stock unavailable'],
    });
  }

  const hasVariants = product.variants && product.variants.length > 0;
  let totalQuantity = 0;
  const variantQuantities: { sku: string; quantity: number }[] = [];

  if (hasVariants) {
    for (const v of product.variants!) {
      const sku = (v as { sku: string }).sku;
      try {
        const avail = await flow.services.quant.getAvailability({ skuRef: sku, locationId: DEFAULT_LOCATION }, flowCtx);
        const qty = avail.quantityOnHand;
        variantQuantities.push({ sku, quantity: qty });
        totalQuantity += qty;
      } catch {
        variantQuantities.push({ sku, quantity: 0 });
      }
    }
  } else {
    try {
      const avail = await flow.services.quant.getAvailability({ skuRef: id, locationId: DEFAULT_LOCATION }, flowCtx);
      totalQuantity = avail.quantityOnHand;
    } catch {
      // no stock data
    }
  }

  // Update stockProjection via catalog repository
  await catalog.repositories.product.updateStockProjection(
    id,
    {
      totalAvailable: totalQuantity,
      variants: variantQuantities.map((v) => ({ sku: v.sku, available: v.quantity })),
    },
    ctx,
  );

  return reply.send({ productId: id, totalQuantity, variantQuantities, synced: true });
}
