import BaseController from '#common/controllers/baseController.js';
import categoryRepository from './category.repository.js';

/**
 * Category Controller
 *
 * Extends BaseController for standard CRUD.
 * Custom methods for slug lookup and tree operations only.
 */
class CategoryController extends BaseController {
    constructor() {
        super(categoryRepository);

        this.getBySlug = this.getBySlug.bind(this);
        this.getTree = this.getTree.bind(this);
    }

    /**
     * Get category by slug (for URL resolution)
     */
    async getBySlug(req, reply) {
        const category = await categoryRepository.getBySlug(req.params.slug);
        if (!category) {
            return reply.code(404).send({
                success: false,
                error: 'Category not found',
            });
        }
        return reply.send({ success: true, data: category });
    }

    /**
     * Get category tree (nested structure)
     * FE caches this and extracts children/flattens as needed
     */
    async getTree(req, reply) {
        const tree = await categoryRepository.getCategoryTree();
        return reply.send({ success: true, data: tree });
    }

    /**
     * Override delete to check product count
     */
    async delete(req, reply) {
        const category = await categoryRepository.getById(req.params.id);
        if (!category) {
            return reply.code(404).send({
                success: false,
                error: 'Category not found',
            });
        }
        if (category.productCount > 0) {
            return reply.code(409).send({
                success: false,
                error: `Cannot delete: ${category.productCount} products still use this category`,
            });
        }
        await categoryRepository.delete(category._id);
        return reply.send({ success: true, message: 'Category deleted' });
    }
}

export default new CategoryController();
