/**
 * Category route handlers — catalog-backed.
 *
 * Each function is a Fastify raw handler imported by category.resource.ts.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { ensureCatalogEngine } from '#resources/catalog/catalog.engine.js';
import { NotFoundError } from '@classytic/arc/utils';

const ctx = { actorId: 'api', roles: ['admin'] as string[], locale: 'en', currency: 'BDT' };

/** GET /categories/slug/:slug */
export async function getBySlug(req: FastifyRequest, reply: FastifyReply) {
  const { slug } = req.params as { slug: string };
  const catalog = await ensureCatalogEngine();
  const categoryRepo = catalog.repositories.category!;
  const cat = await categoryRepo.getByQuery({ slug }, { ...ctx, throwOnNotFound: false });
  if (!cat) throw new NotFoundError('Category not found');
  return reply.send(cat);
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
  return reply.send(tree);
}

/** GET /categories/:parentSlug/children */
export async function getChildren(req: FastifyRequest, reply: FastifyReply) {
  const { parentSlug } = req.params as { parentSlug: string };
  const catalog = await ensureCatalogEngine();
  const children = await catalog.repositories.category!.findAll({ parent: parentSlug }, ctx);
  return reply.send(children);
}

/** POST /categories/sync-counts */
export async function syncCounts(_req: FastifyRequest, reply: FastifyReply) {
  return reply.send({ message: 'Product counts are now maintained automatically by the catalog engine' });
}
