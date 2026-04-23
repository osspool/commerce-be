/**
 * Catalog-backed product adapter for Arc's resource system.
 *
 * Uses mongokit base methods directly — no custom naming.
 * Arc handles route registration, permissions, pagination, and caching.
 */

import type { RepositoryLike } from '@classytic/arc';
import type { CatalogEngine } from '@classytic/catalog/engine';
import { ensureCatalogEngine } from '#resources/catalog/catalog.engine.js';

async function engine(): Promise<CatalogEngine> {
  return ensureCatalogEngine();
}

/**
 * Extends `RepositoryLike` with the product-specific domain methods arc
 * routes wire via lookupPreset bindings. Declaring them on the interface
 * lets the object literal type-check without an excess-property cast.
 */
interface CatalogProductAdapter extends RepositoryLike {
  getBySlug(slug: string): Promise<unknown>;
  getDeleted(params?: unknown, options?: unknown): Promise<unknown>;
  restore(id: string): Promise<unknown>;
}

export function createCatalogProductAdapter(): CatalogProductAdapter {
  const adapter: CatalogProductAdapter = {
    idField: '_id',

    async getAll(params: Record<string, unknown> = {}): Promise<unknown> {
      const e = await engine();
      const filter: Record<string, unknown> = {};
      const ctx = { actorId: 'arc-adapter', roles: ['admin'] as string[], locale: 'en', currency: 'BDT' };

      const filters = (params.filters ?? {}) as Record<string, unknown>;
      if (filters.status) filter.status = filters.status;
      // The FE filter UI (`useProductSearch`, `useInventorySearch`) sends the
      // user-facing `category` / `parentCategory` names; the DB field is
      // `categorySlug`. Accept either so both the clean URL shape and the
      // legacy direct-DB-field shape keep working.
      const categorySlug = filters.categorySlug ?? filters.category;
      if (categorySlug) filter.categorySlug = categorySlug;
      if (filters.productType) filter.productType = filters.productType;
      if (filters.tags) filter.tags = filters.tags;
      if (filters.collections) filter.collections = filters.collections;
      // `isActive` is a FE UI sugar for status — "true" → active, "false" → archived.
      // Skip mapping when status was already supplied explicitly.
      if (filters.isActive !== undefined && !filter.status) {
        const isActive = filters.isActive;
        filter.status = (isActive === true || isActive === 'true') ? 'active' : 'archived';
      }
      // Allow price-range filters on the canonical catalog path.
      // QueryParser converts `[gte]`/`[lte]` suffixes into `{ $gte, $lte }` objects.
      const PRICE_PATH = 'defaultMonetization.pricing.basePrice.amount';
      if (filters[PRICE_PATH]) filter[PRICE_PATH] = filters[PRICE_PATH];

      // parentCategorySlug → expand to the parent itself + its direct children.
      // The category schema stores `parent` (direct parent slug) and
      // `parentPath` (slash-joined ancestor chain); we match both so 1- and
      // 2-level deep trees work without requiring the client to pre-resolve.
      // Accept both the canonical `parentCategorySlug` and the FE-facing
      // `parentCategory` alias (same reason as `category` / `categorySlug`).
      const parentCategorySlug = filters.parentCategorySlug ?? filters.parentCategory;
      if (parentCategorySlug && !filter.categorySlug) {
        const parentSlug = parentCategorySlug as string;
        const descendants = (await e.repositories.category?.findAll?.(
          {
            $or: [{ slug: parentSlug }, { parent: parentSlug }, { parentPath: { $regex: `(^|/)${parentSlug}(/|$)` } }],
          },
          { lean: true },
        )) as Array<{ slug: string }> | undefined;
        const slugs = descendants?.map((c) => c.slug) ?? [parentSlug];
        filter.categorySlug = slugs.length === 1 ? slugs[0] : { $in: slugs };
      }

      if (params.search) {
        const result = await e.utilities.query.search(
          {
            search: params.search as string,
            status: filter.status as 'active' | 'draft' | 'archived' | undefined,
            categorySlug: filter.categorySlug as string | undefined,
            limit: (params.limit as number) ?? 20,
            page: (params.page as number) ?? 1,
            sortBy: params.sort as string | undefined,
          },
          ctx,
        );
        return {
          docs: result.items,
          totalDocs: result.total,
          page: result.page,
          totalPages: result.pages,
          limit: result.limit,
        };
      }

      return e.repositories.product.getAll({
        filters: filter,
        page: (params.page as number) ?? 1,
        limit: (params.limit as number) ?? 20,
        sort: params.sort as string | undefined,
      });
    },

    async getById(id: string): Promise<unknown> {
      return (await engine()).repositories.product.getById(id, { throwOnNotFound: false });
    },

    async getOne(filter: Record<string, unknown>): Promise<unknown> {
      const e = await engine();
      if (filter.slug) {
        return e.repositories.product.getByQuery({ slug: filter.slug as string }, { throwOnNotFound: false });
      }
      const list = await e.repositories.product.findAll(filter, { lean: true });
      return list[0] ?? null;
    },

    async getBySlug(slug: string): Promise<unknown> {
      return (await engine()).repositories.product.getByQuery({ slug }, { throwOnNotFound: false });
    },

    async create(data: unknown): Promise<unknown> {
      return (await engine()).repositories.product.create(data as Record<string, unknown>);
    },

    async update(id: string, data: unknown): Promise<unknown> {
      return (await engine()).repositories.product.update(id, data as Record<string, unknown>);
    },

    async delete(
      id: string,
      _options?: unknown,
    ): Promise<{ success: boolean; message: string; id?: string; soft?: boolean }> {
      await (await engine()).repositories.product.delete(id);
      return { success: true, message: 'Deleted', id, soft: false };
    },

    async getDeleted(_params?: unknown, _options?: unknown): Promise<unknown> {
      return (await engine()).repositories.product.getAll({
        filters: { status: 'archived' },
      });
    },

    async restore(id: string): Promise<unknown> {
      return (await engine()).repositories.product.update(id, { status: 'draft' });
    },
  };
  return adapter;
}
