import { BaseController } from '@classytic/arc';
import CMSRepository from './cms.repository.js';
import { cmsSchemaOptions } from './cms.schemas.js';

class CMSController extends BaseController {
  constructor() {
    super(CMSRepository, { schemaOptions: cmsSchemaOptions });
    this.getBySlug = this.getBySlug.bind(this);
    this.getOrCreateBySlug = this.getOrCreateBySlug.bind(this);
    this.updateBySlug = this.updateBySlug.bind(this);
    this.deleteBySlug = this.deleteBySlug.bind(this);
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
   * Update or create CMS page by slug (admin only)
   * PATCH /cms/:slug
   */
  async updateBySlug(req, reply) {
    const { slug } = req.params;
    const updates = { ...req.body, slug };

    // Do not allow slug updates through payload to avoid mismatches
    if ('slug' in req.body) {
      delete updates.slug;
      updates.slug = slug; // Force slug from URL
    }

    // Ensure name defaults to slug if not provided
    if (!updates.name) {
      updates.name = slug;
    }

    // Simple upsert: update if exists, create if doesn't
    const page = await CMSRepository.Model.findOneAndUpdate(
      { slug },
      { $set: updates },
      { upsert: true, new: true, runValidators: true }
    );

    return reply.code(200).send({ success: true, data: page });
  }

  /**
   * Delete CMS page by slug (admin only)
   * DELETE /cms/:slug
   */
  async deleteBySlug(req, reply) {
    const { slug } = req.params;
    const page = await CMSRepository.Model.findOneAndDelete({ slug });

    if (!page) {
      return reply.code(404).send({
        success: false,
        message: `Page with slug "${slug}" not found`,
      });
    }

    return reply.code(200).send({
      success: true,
      message: `Page "${slug}" deleted successfully`,
    });
  }
}

const cmsController = new CMSController();

export default cmsController;
