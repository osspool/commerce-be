/**
 * Product route handlers — catalog-backed.
 *
 * Each function is a Fastify raw handler imported by product.resource.ts.
 * Business logic delegated to catalog engine services.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { ensureCatalogEngine } from '#resources/catalog/catalog.engine.js';
import { buildFlowContext, DEFAULT_LOCATION } from '#resources/inventory/flow/context-helpers.js';
import { getFlowEngineOrNull } from '#resources/inventory/flow/flow-engine.js';

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
    return reply.code(404).send({ success: false, error: 'Product not found' });
  }
  return reply.send({ success: true, data: product });
}

/** GET /products/:productId/recommendations */
export async function getRecommendations(req: FastifyRequest, reply: FastifyReply) {
  const { productId } = req.params as { productId: string };
  const catalog = await ensureCatalogEngine();
  try {
    const related = await catalog.utilities.query.getRelated(productId, 'related', catalogCtx(req), { limit: 4 });
    return reply.send({ success: true, data: related });
  } catch {
    return reply.send({ success: true, data: [] });
  }
}

/**
 * POST /products/:id/sync-stock
 *
 * Reads current on-hand from Flow for each variant (or product._id for simple)
 * and updates the cached stockProjection on the catalog product.
 */
export async function syncStock(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const catalog = await ensureCatalogEngine();
  const ctx = catalogCtx(req);

  const product = await catalog.repositories.product.getById(id, ctx);
  if (!product) {
    return reply.code(404).send({ success: false, error: 'Product not found' });
  }

  const flow = getFlowEngineOrNull();
  if (!flow) {
    return reply.send({
      success: true,
      data: { productId: id, totalQuantity: 0, synced: false, errors: ['Flow engine not available'] },
    });
  }

  const orgId =
    (req as unknown as { scope?: { organizationId?: string } }).scope?.organizationId ||
    (req.headers['x-organization-id'] as string);
  const flowCtx = buildFlowContext(orgId);

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

  return reply.send({
    success: true,
    data: { productId: id, totalQuantity, variantQuantities, synced: true },
  });
}
