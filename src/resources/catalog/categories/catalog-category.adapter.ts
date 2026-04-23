/**
 * Catalog-backed category adapter for Arc's resource system.
 *
 * Wraps catalog's CategoryRepository into Arc's `RepositoryLike` interface.
 * Uses mongokit base methods directly — no custom naming.
 */

import type { RepositoryLike } from '@classytic/arc';
import { ensureCatalogEngine } from '#resources/catalog/catalog.engine.js';

/**
 * Extends `RepositoryLike` with the category-specific domain methods arc
 * routes wire via lookupPreset bindings. Declaring them on the interface
 * lets the object literal type-check without an excess-property cast.
 */
interface CatalogCategoryAdapter extends RepositoryLike {
  getBySlug(slug: string): Promise<unknown>;
  getTree(): Promise<unknown>;
  getChildren(parentSlug: string): Promise<unknown>;
}

export function createCatalogCategoryAdapter(): CatalogCategoryAdapter {
  const adapter: CatalogCategoryAdapter = {
    idField: '_id',

    async getAll(params: Record<string, unknown> = {}): Promise<unknown> {
      const e = await ensureCatalogEngine();
      const categoryRepo = e.repositories.category!;
      const filter: Record<string, unknown> = {};
      const filters = (params.filters ?? {}) as Record<string, unknown>;
      if (filters.parent !== undefined) filter.parent = filters.parent;
      if (filters.isActive !== undefined) filter.isActive = filters.isActive;

      return categoryRepo.getAll({
        filters: filter,
        page: (params.page as number) ?? 1,
        limit: (params.limit as number) ?? 100,
      });
    },

    async getById(id: string): Promise<unknown> {
      return (await ensureCatalogEngine()).repositories.category!.getById(id, { throwOnNotFound: false });
    },

    async getOne(filter: Record<string, unknown>): Promise<unknown> {
      const e = await ensureCatalogEngine();
      const categoryRepo = e.repositories.category!;
      if (filter.slug) {
        return categoryRepo.getByQuery({ slug: filter.slug as string }, { throwOnNotFound: false });
      }
      const list = await categoryRepo.findAll(filter, { lean: true });
      return list[0] ?? null;
    },

    async getBySlug(slug: string): Promise<unknown> {
      return (await ensureCatalogEngine()).repositories.category!.getByQuery({ slug }, { throwOnNotFound: false });
    },

    async create(data: unknown): Promise<unknown> {
      // Catalog's `categoryCreateSchema` requires `name`, `slug`, `displayOrder`,
      // `isActive`. Legacy API callers sent only `name`, so fill in sensible
      // defaults for the rest — `slug` derived from `name`.
      const input = (data ?? {}) as Record<string, unknown>;
      const patched: Record<string, unknown> = { ...input };
      if (!patched.slug && typeof patched.name === 'string') {
        patched.slug = patched.name
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
      }
      if (patched.displayOrder === undefined) patched.displayOrder = 0;
      if (patched.isActive === undefined) patched.isActive = true;
      return (await ensureCatalogEngine()).repositories.category!.create(patched);
    },

    async update(id: string, data: unknown): Promise<unknown> {
      return (await ensureCatalogEngine()).repositories.category!.update(id, data as Record<string, unknown>);
    },

    async delete(id: string, _options?: unknown): Promise<{ success: boolean; message: string; id?: string }> {
      const e = await ensureCatalogEngine();
      await e.repositories.category!.delete(id);
      return { success: true, message: 'Deleted', id };
    },

    async getTree(): Promise<unknown> {
      const e = await ensureCatalogEngine();
      const categoryRepo = e.repositories.category!;
      const roots = await categoryRepo.findAll({ parent: null });
      const tree = [];
      for (const root of roots) {
        const slug = (root as unknown as Record<string, unknown>).slug as string;
        const children = await categoryRepo.findAll({ parent: slug });
        tree.push({ ...root, children });
      }
      return tree;
    },

    async getChildren(parentSlug: string): Promise<unknown> {
      return (await ensureCatalogEngine()).repositories.category!.findAll({ parent: parentSlug });
    },
  };
  return adapter;
}
