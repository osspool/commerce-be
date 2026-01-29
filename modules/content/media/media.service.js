class MediaService {
  /**
   * @param {import('@classytic/media-kit').MediaKit} mediaKit
   */
  constructor(mediaKit) {
    this.media = mediaKit;
    this.repo = mediaKit.repository;
  }

  // ============================================
  // CRUD (for BaseController)
  // ============================================
  async getAll(params = {}, options = {}) {
    return this.repo.getAllMedia(params, options.context);
  }

  async getById(id, options = {}) {
    const doc = await this.media.getById(id, options.context);
    if (!doc) {
      const err = new Error('Media not found');
      err.statusCode = 404;
      throw err;
    }
    return doc;
  }

  async create(data, options = {}) {
    return this.media.upload(data, options.context);
  }

  async update(id, data, options = {}) {
    const doc = await this.repo.updateMedia(id, data, options.context);
    if (!doc) {
      const err = new Error('Media not found');
      err.statusCode = 404;
      throw err;
    }
    return doc;
  }

  async delete(id, options = {}) {
    const deleted = await this.media.delete(id, options.context);
    if (!deleted) {
      const err = new Error('Media not found');
      err.statusCode = 404;
      throw err;
    }
    return { success: true, message: 'Media deleted' };
  }

  // ============================================
  // Uploads
  // ============================================
  async upload(input, context) {
    return this.media.upload(input, context);
  }

  async uploadMany(inputs, context) {
    return this.media.uploadMany(inputs, context);
  }

  // ============================================
  // Bulk & folders
  // ============================================
  async deleteMany(ids, context) {
    return this.media.deleteMany(ids, context);
  }

  async move(ids, targetFolder, context) {
    return this.media.move(ids, targetFolder, context);
  }

  async getFolderTree(context) {
    return this.media.getFolderTree(context);
  }

  async getFolderStats(folder, context) {
    return this.media.getFolderStats(folder, context);
  }

  getBreadcrumb(folder) {
    return this.media.getBreadcrumb(folder);
  }

  async deleteFolder(folder, context) {
    return this.media.deleteFolder(folder, context);
  }
}

export default MediaService;
