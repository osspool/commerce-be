import {
    Repository,
    validationChainPlugin,
    requireField,
    uniqueField,
    cachePlugin,
} from '@classytic/mongokit';
import Category from './category.model.js';
import { getSharedCacheAdapter } from '#shared/adapters/memoryCache.adapter.js';

const categoryCacheAdapter = getSharedCacheAdapter({ maxSize: 500 });

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
class CategoryRepository extends Repository {
    constructor() {
        super(Category, [
            validationChainPlugin([
                requireField('name', ['create']),
                uniqueField('slug', 'Category slug already exists'),
            ]),
            cachePlugin({
                adapter: categoryCacheAdapter,
                ttl: 300,
                byIdTtl: 600,
                queryTtl: 300,
            }),
        ], {
            defaultLimit: 100,
            maxLimit: 200,
        });

        this._setupEvents();
    }

    _setupEvents() {
        // Auto-filter inactive categories for public queries
        this.on('before:getAll', (context) => {
            if (!context.includeInactive) {
                context.filters = { ...context.filters, isActive: true };
            }
        });

        // Default sorting by display order
        this.on('before:getAll', (context) => {
            if (!context.sort) {
                context.sort = { displayOrder: 1, name: 1 };
            }
        });
    }

    /**
     * Get category by slug
     * @param {string} slug - Category slug
     * @param {Object} options - Query options
     * @returns {Promise<Object|null>}
     */
    async getBySlug(slug, options = {}) {
        return this.getByQuery({ slug: slug.toLowerCase() }, options);
    }

    /**
     * Get root categories (no parent)
     * @returns {Promise<Array>}
     */
    async getRootCategories() {
        return this.Model.find({ parent: null, isActive: true })
            .sort({ displayOrder: 1, name: 1 })
            .lean();
    }

    /**
     * Get child categories
     * @param {string} parentSlug - Parent category slug
     * @returns {Promise<Array>}
     */
    async getChildren(parentSlug) {
        return this.Model.find({ parent: parentSlug.toLowerCase(), isActive: true })
            .sort({ displayOrder: 1, name: 1 })
            .lean();
    }

    /**
     * Get full category tree (nested structure)
     * Optimized: single query + in-memory tree building
     * @returns {Promise<Array>}
     */
    async getTree() {
        const all = await this.Model.find({ isActive: true })
            .sort({ displayOrder: 1, name: 1 })
            .lean();

        // Build tree in memory
        const map = new Map();
        const roots = [];

        // First pass: index by slug
        for (const cat of all) {
            map.set(cat.slug, { ...cat, children: [] });
        }

        // Second pass: build tree
        for (const cat of all) {
            const node = map.get(cat.slug);
            if (cat.parent && map.has(cat.parent)) {
                map.get(cat.parent).children.push(node);
            } else {
                roots.push(node);
            }
        }

        return roots;
    }

    /**
     * Get flat category list with depth
     * Useful for admin select dropdowns
     * @returns {Promise<Array>}
     */
    async getFlatList() {
        const tree = await this.getTree();
        const result = [];

        const flatten = (nodes, depth = 0) => {
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
     * @param {string} slug - Category slug
     * @param {number} delta - Change in count (+1 or -1)
     */
    async updateProductCount(slug, delta) {
        if (!slug) return;
        await this.Model.updateOne(
            { slug: slug.toLowerCase() },
            { $inc: { productCount: delta } }
        );
    }

    /**
     * Recalculate product counts for all categories
     * Run as maintenance task
     */
    async recalculateAllCounts() {
        const Product = (await import('../product/product.model.js')).default;

        const counts = await Product.aggregate([
            { $match: { deletedAt: null, isActive: true } },
            { $group: { _id: '$category', count: { $sum: 1 } } },
        ]);

        const countMap = new Map(counts.map(c => [c._id, c.count]));

        const categories = await this.Model.find().lean();
        for (const cat of categories) {
            const count = countMap.get(cat.slug) || 0;
            await this.Model.updateOne({ _id: cat._id }, { productCount: count });
        }

        return { updated: categories.length };
    }

    /**
     * Get all category slugs (for validation)
     * @returns {Promise<Set<string>>}
     */
    async getAllSlugs() {
        const categories = await this.Model.find().select('slug').lean();
        return new Set(categories.map(c => c.slug));
    }
}

export default new CategoryRepository();
