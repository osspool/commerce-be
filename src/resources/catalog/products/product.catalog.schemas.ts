/**
 * Zod v4 schemas for catalog-backed product routes.
 *
 * Arc's convertRouteSchema() auto-converts these to JSON Schema
 * for Fastify validation + OpenAPI docs.
 */

import { z } from 'zod';

export const slugParam = z.object({
  slug: z.string().min(1).describe('Product slug'),
});

export const idParam = z.object({
  id: z.string().min(1).describe('Product ID'),
});

export const productIdParam = z.object({
  productId: z.string().min(1).describe('Product ID for recommendations'),
});
