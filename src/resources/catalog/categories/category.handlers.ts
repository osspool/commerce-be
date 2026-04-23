/**
 * Category route handlers — catalog-backed.
 *
 * Each function is a Fastify raw handler imported by category.resource.ts.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { ensureCatalogEngine } from '#resources/catalog/catalog.engine.js';

const ctx = { actorId: 'api', roles: ['admin'] as string[], locale: 'en', currency: 'BDT' };

/** GET /categories/slug/:slug */
export async function getBySlug(req: FastifyRequest, reply: FastifyReply) {
  const { slug } = req.params as { slug: string };
  const catalog = await ensureCatalogEngine();
  const categoryRepo = catalog.repositories.category!;
  const cat = await categoryRepo.getByQuery({ slug }, { ...ctx, throwOnNotFound: false });
  if (!cat) return reply.code(404).send({ success: false, error: 'Category not found' });
  return reply.send({ success: true, data: cat });
}

/** GET /categories/tree */
export async function getTree(_req: FastifyRequest, reply: FastifyReply) {
  const catalog = await ensureCatalogEngine();
  const categoryRepo = catalog.repositories.category!;
  const roots = await categoryRepo.findAll({ parent: null }, ctx);
  const tree = [];
  for (const root of roots) {
    const children = await categoryRepo.findAll({ parent: root.slug }, ctx);
    tree.push({ ...root, children });
  }
  return reply.send({ success: true, data: tree });
}

/** GET /categories/:parentSlug/children */
export async function getChildren(req: FastifyRequest, reply: FastifyReply) {
  const { parentSlug } = req.params as { parentSlug: string };
  const catalog = await ensureCatalogEngine();
  const children = await catalog.repositories.category!.findAll({ parent: parentSlug }, ctx);
  return reply.send({ success: true, data: children });
}

/** POST /categories/sync-counts */
export async function syncCounts(_req: FastifyRequest, reply: FastifyReply) {
  return reply.send({
    success: true,
    message: 'Product counts are now maintained automatically by the catalog engine',
  });
}
