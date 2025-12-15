import BaseController from '#common/controllers/baseController.js';
import CMSRepository from './cms.repository.js';
import { cmsSchemaOptions } from './cms.schemas.js';

class CMSController extends BaseController {
  constructor() {
    super(CMSRepository, cmsSchemaOptions);
    this.getBySlug = this.getBySlug.bind(this);
    this.getOrCreateBySlug = this.getOrCreateBySlug.bind(this);
    this.updateBySlug = this.updateBySlug.bind(this);
  }

  /**
   * Get CMS page by slug (public)
   * GET /cms/:slug
   */
  async getBySlug(req, reply) {
    const { slug } = req.params;
    const page = await CMSRepository.getByQuery({ slug });

    if (!page) {
      return reply.code(404).send({
        success: false,
        message: `Page with slug "${slug}" not found`,
      });
    }

    return reply.code(200).send({ success: true, data: page });
  }

  /**
   * Get or create CMS page by slug (admin only)
   * POST /cms/:slug
   * Body should contain defaults for creation
   */
  async getOrCreateBySlug(req, reply) {
    const { slug } = req.params;
    const defaults = req.body || {};

    const page = await CMSRepository.getOrCreate(
      { slug },
      { ...defaults, name: defaults.name || slug, slug },
    );

    return reply.code(200).send({ success: true, data: page });
  }

  /**
   * Update CMS page by slug (admin only)
   * PATCH /cms/:slug
   */
  async updateBySlug(req, reply) {
    const { slug } = req.params;
    const updates = { ...req.body };

    // Do not allow slug updates through payload to avoid mismatches
    if ('slug' in updates) {
      delete updates.slug;
    }

    // Find page by slug first
    const page = await CMSRepository.getByQuery({ slug });

    if (!page) {
      return reply.code(404).send({
        success: false,
        message: `Page with slug "${slug}" not found`,
      });
    }

    // Update by ID
    const updated = await CMSRepository.update(page._id, updates);
    return reply.code(200).send({ success: true, data: updated });
  }
}

const cmsController = new CMSController();

export default cmsController;
