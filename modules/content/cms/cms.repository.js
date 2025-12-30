import { Repository } from '@classytic/mongokit';
import CMS from './cms.model.js';

class CMSRepository extends Repository {
  constructor() {
    super(CMS);
  }

  async getOrCreate(filter, data, options = {}) {
    // Auto-set publishedAt when status is published
    if (data.status === 'published' && !data.publishedAt) {
      data.publishedAt = new Date();
    }
    return super.getOrCreate(filter, data, options);
  }

  async create(data, options = {}) {
    // Auto-set publishedAt when status is published
    if (data.status === 'published' && !data.publishedAt) {
      data.publishedAt = new Date();
    }
    return super.create(data, options);
  }

  async update(id, data, options = {}) {
    // Auto-set publishedAt when status changes to published
    if (data.status === 'published') {
      const existing = await this.getById(id, { select: 'publishedAt status' });
      if (existing.status !== 'published' && !data.publishedAt) {
        data.publishedAt = new Date();
      }
    }
    return super.update(id, data, options);
  }
}

export default new CMSRepository();
