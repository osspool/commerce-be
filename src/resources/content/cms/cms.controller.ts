import { BaseController } from '@classytic/arc';
import type { FastifyReply, FastifyRequest } from 'fastify';
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
   */
  async getBySlug(req: FastifyRequest<{ Params: { slug: string } }> | any, reply?: FastifyReply): Promise<any> {
    const { slug } = req.params;
    const page = await CMSRepository.getByQuery({ slug }, { throwOnNotFound: false });

    if (!page) {
      return reply?.code(404).send({
        success: false,
        message: `Page with slug "${slug}" not found`,
      });
    }

    return reply?.code(200).send({ success: true, data: page });
  }

  /**
   * Get or create CMS page by slug (admin only)
   */
  async getOrCreateBySlug(
    req: FastifyRequest<{ Params: { slug: string }; Body: Record<string, unknown> }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { slug } = req.params;
    const defaults = req.body || {};

    const page = await CMSRepository.getOrCreate(
      { slug },
      { ...defaults, name: (defaults as Record<string, unknown>).name || slug, slug },
    );

    return reply.code(200).send({ success: true, data: page });
  }

  /**
   * Update or create CMS page by slug (admin only)
   */
  async updateBySlug(
    req: FastifyRequest<{ Params: { slug: string }; Body: Record<string, unknown> }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { slug } = req.params;
    const updates: Record<string, unknown> = { ...req.body, slug };

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
      { upsert: true, returnDocument: 'after', runValidators: true },
    );

    return reply.code(200).send({ success: true, data: page });
  }

  /**
   * Delete CMS page by slug (admin only)
   */
  async deleteBySlug(req: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply): Promise<void> {
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
