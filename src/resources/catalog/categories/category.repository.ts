import { Repository, validationChainPlugin, requireField, uniqueField, cachePlugin } from '@classytic/mongokit';
import Category from './category.model.js';
import type { ICategory } from './category.model.js';
import { getSharedCacheAdapter } from '#shared/adapters/memoryCache.adapter.js';

const categoryCacheAdapter = getSharedCacheAdapter({ maxSize: 500 });

interface CategoryTreeNode extends Record<string, unknown> {
  _id: unknown;
  slug: string;
  name: string;
  parent: string | null;
  productCount: number;
  children: CategoryTreeNode[];
}

interface FlatCategoryItem {
  _id: unknown;
  slug: string;
  name: string;
  depth: number;
  displayName: string;
  productCount: number;
}

interface RecalculateResult {
  updated: number;
}

/**
 * Category Repository
 *
 * Uses MongoKit with slug-based pattern for product references.
 * Products store `category.slug` as string, enabling fast queries without $lookup.
 *
 * Key Design:
 * - Slug is immutable after creation (products reference it)
 * - Name can be changed freely (display only)
 * - Product count maintained via events
 */
class CategoryRepository extends Repository<ICategory> {
  constructor() {
    super(
      Category,
      [
        validationChainPlugin([requireField('name', ['create']), uniqueField('slug', 'Category slug already exists')]),
        cachePlugin({
          adapter: categoryCacheAdapter,
          ttl: 300,
          byIdTtl: 600,
          queryTtl: 300,
        }),
      ],
      {
        defaultLimit: 100,
        maxLimit: 200,
      },
    );

    this._setupEvents();
  }

  _setupEvents(): void {
    // Auto-filter inactive categories for public queries
    this.on('before:getAll', (context: Record<string, unknown>) => {
      if (!context.includeInactive) {
        context.filters = { ...(context.filters as Record<string, unknown>), isActive: true };
      }
    });

    // Default sorting by display order
    this.on('before:getAll', (context: Record<string, unknown>) => {
      if (!context.sort) {
        context.sort = { displayOrder: 1, name: 1 };
      }
    });
  }

  /**
   * Get category by slug
   */
  async getBySlug(slug: string, options: Record<string, unknown> = {}): Promise<ICategory | null> {
    return this.getByQuery({ slug: slug.toLowerCase() }, options) as Promise<ICategory | null>;
  }

  /**
   * Get root categories (no parent)
   */
  async getRootCategories(): Promise<ICategory[]> {
    return this.Model.find({ parent: null, isActive: true }).sort({ displayOrder: 1, name: 1 }).lean();
  }

  /**
   * Get child categories
   */
  async getChildren(parentSlug: string): Promise<ICategory[]> {
    return this.Model.find({ parent: parentSlug.toLowerCase(), isActive: true })
      .sort({ displayOrder: 1, name: 1 })
      .lean();
  }

  /**
   * Get full category tree (nested structure)
   * Optimized: single query + in-memory tree building
   */
  async getTree(): Promise<CategoryTreeNode[]> {
    const all = await this.Model.find({ isActive: true }).sort({ displayOrder: 1, name: 1 }).lean();

    // Build tree in memory
    const map = new Map<string, CategoryTreeNode>();
    const roots: CategoryTreeNode[] = [];

    // First pass: index by slug
    for (const cat of all) {
      map.set(cat.slug, { ...cat, children: [] } as CategoryTreeNode);
    }

    // Second pass: build tree
    for (const cat of all) {
      const node = map.get(cat.slug)!;
      if (cat.parent && map.has(cat.parent)) {
        map.get(cat.parent)?.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  /**
   * Get flat category list with depth
   * Useful for admin select dropdowns
   */
  async getFlatList(): Promise<FlatCategoryItem[]> {
    const tree = await this.getTree();
    const result: FlatCategoryItem[] = [];

    const flatten = (nodes: CategoryTreeNode[], depth: number = 0): void => {
      for (const node of nodes) {
        result.push({
          _id: node._id,
          slug: node.slug,
          name: node.name,
          depth,
          displayName: '  '.repeat(depth) + node.name,
          productCount: node.productCount,
        });
        if (node.children?.length) {
          flatten(node.children, depth + 1);
        }
      }
    };

    flatten(tree);
    return result;
  }

  /**
   * Update product count for a category
   * Called by product repository on create/update/delete
   */
  async updateProductCount(slug: string, delta: number): Promise<void> {
    if (!slug) return;
    await this.Model.updateOne({ slug: slug.toLowerCase() }, { $inc: { productCount: delta } });
  }

  /**
   * Recalculate product counts for all categories
   * Run as maintenance task
   */
  async recalculateAllCounts(): Promise<RecalculateResult> {
    const Product = (await import('../products/product.model.js')).default;

    const counts = await Product.aggregate([
      { $match: { deletedAt: null, isActive: true } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
    ]);

    const countMap = new Map<string, number>(counts.map((c: { _id: string; count: number }) => [c._id, c.count]));

    const categories = await this.Model.find().lean();
    for (const cat of categories) {
      const count = countMap.get(cat.slug) || 0;
      await this.Model.updateOne({ _id: cat._id }, { productCount: count });
    }

    return { updated: categories.length };
  }

  /**
   * Get all category slugs (for validation)
   */
  async getAllSlugs(): Promise<Set<string>> {
    const categories = await this.Model.find().select('slug').lean();
    return new Set(categories.map((c: { slug: string }) => c.slug));
  }
}

export default new CategoryRepository();
