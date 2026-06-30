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

// In-memory cache for the storefront nav tree. The `/tree` route is `raw:true`
// so it bypasses the resource's adapter `cache` config — yet it's read on
// EVERY page load while categories change rarely. 60s TTL matches the resource
// `cache.staleTime`; edits self-heal within the window (or call
// `invalidateCategoryTreeCache()` from category mutations for instant refresh).
let treeCache: { data: unknown; expiresAt: number } | null = null;
const TREE_TTL_MS = 60_000;

export function invalidateCategoryTreeCache(): void {
  treeCache = null;
}

/** GET /categories/tree */
export async function getTree(_req: FastifyRequest, reply: FastifyReply) {
  const now = Date.now();
  if (treeCache && treeCache.expiresAt > now) {
    return reply.send(treeCache.data);
  }

  const catalog = await ensureCatalogEngine();
  const categoryRepo = catalog.repositories.category!;

  // ONE query for the whole (small) category set, then group by parent in
  // memory. The previous version ran 1 + N SEQUENTIAL queries (a query per
  // root category) — on remote MongoDB (~150ms/round-trip) that turned a tiny
  // dataset into a 1–9s endpoint (the slow / erratic storefront navbar). A
  // category catalog is dozens of rows; build the 2-level tree in memory.
  const all = (await categoryRepo.findAll({}, { ...ctx, limit: 1000 })) as unknown as Array<
    Record<string, unknown> & { slug: string; parent?: string | null }
  >;

  const byParent = new Map<string, typeof all>();
  for (const c of all) {
    const key = c.parent ?? '__root__';
    const bucket = byParent.get(key);
    if (bucket) bucket.push(c);
    else byParent.set(key, [c]);
  }

  const roots = byParent.get('__root__') ?? [];
  const tree = roots.map((root) => ({ ...root, children: byParent.get(root.slug) ?? [] }));

  treeCache = { data: tree, expiresAt: now + TREE_TTL_MS };
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
