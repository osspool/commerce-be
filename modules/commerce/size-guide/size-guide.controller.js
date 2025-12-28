import BaseController from '#common/controllers/baseController.js';
import sizeGuideRepository from './size-guide.repository.js';

/**
 * Size Guide Controller
 *
 * Extends BaseController for standard CRUD.
 * No custom methods needed - MongoKit + BaseController handles everything.
 */
class SizeGuideController extends BaseController {
    constructor() {
        super(sizeGuideRepository);

        this.getBySlug = this.getBySlug.bind(this);
    }

    /**
     * Get size guide by slug (for product display)
     */
    async getBySlug(req, reply) {
        const sizeGuide = await sizeGuideRepository.getBySlug(req.params.slug);
        if (!sizeGuide) {
            return reply.code(404).send({
                success: false,
                error: 'Size guide not found',
            });
        }
        return reply.send({ success: true, data: sizeGuide });
    }
}

export default new SizeGuideController();
