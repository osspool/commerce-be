import { Repository } from '@classytic/mongokit';
import type { ICMS } from './cms.model.js';
import CMS from './cms.model.js';

class CMSRepository extends Repository<ICMS> {
  constructor() {
    super(CMS);
  }

  async getOrCreate(
    filter: Record<string, unknown>,
    data: Record<string, unknown>,
    options: Record<string, unknown> = {},
  ) {
    // Auto-set publishedAt when status is published
    if (data.status === 'published' && !data.publishedAt) {
      data.publishedAt = new Date();
    }
    return super.getOrCreate(filter, data, options);
  }

  async create(data: Record<string, unknown>, options: Record<string, unknown> = {}) {
    // Auto-set publishedAt when status is published
    if (data.status === 'published' && !data.publishedAt) {
      data.publishedAt = new Date();
    }
    return super.create(data, options);
  }

  async update(id: string, data: Record<string, unknown>, options: Record<string, unknown> = {}) {
    // Auto-set publishedAt when status changes to published
    if (data.status === 'published') {
      const existing = (await this.getById(id, { select: 'publishedAt status' })) as Record<string, unknown> | null;
      if (existing && existing.status !== 'published' && !data.publishedAt) {
        data.publishedAt = new Date();
      }
    }
    return super.update(id, data, options);
  }
}

export default new CMSRepository();
