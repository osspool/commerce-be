interface MediaKit {
  repository: Record<string, unknown>;
  upload: (input: unknown, context?: unknown) => Promise<unknown>;
  uploadMany: (inputs: unknown[], context?: unknown) => Promise<unknown[]>;
  getById: (id: string, context?: unknown) => Promise<unknown>;
  delete: (id: string, context?: unknown) => Promise<unknown>;
  deleteMany: (ids: string[], context?: unknown) => Promise<{ success: string[]; failed: string[] }>;
  move: (ids: string[], folder: string, context?: unknown) => Promise<{ modifiedCount: number }>;
  getSignedUploadUrl: (filename: string, mimeType: string, options?: Record<string, unknown>) => Promise<unknown>;
  confirmUpload: (input: unknown, context?: unknown) => Promise<unknown>;
  getFolderTree: (context?: unknown) => Promise<unknown>;
  getFolderStats: (folder: string, context?: unknown) => Promise<unknown>;
  getBreadcrumb: (folder: string) => unknown;
  getSubfolders: (folder: string, context?: unknown) => Promise<unknown>;
  renameFolder: (oldPath: string, newPath: string, context?: unknown) => Promise<unknown>;
  deleteFolder: (folder: string, context?: unknown) => Promise<{ success: string[]; failed: string[] }>;
  addTags: (id: string, tags: string[], context?: unknown) => Promise<unknown>;
  removeTags: (id: string, tags: string[], context?: unknown) => Promise<unknown>;
}

interface ServiceContext {
  userId?: string;
}

interface ServiceOptions {
  context?: ServiceContext;
  [key: string]: unknown;
}

class MediaService {
  media: MediaKit;
  repo: Record<string, unknown>;

  constructor(mediaKit: MediaKit) {
    this.media = mediaKit;
    this.repo = mediaKit.repository;
  }

  // ============================================
  // CRUD (for BaseController)
  // ============================================
  async getAll(params: Record<string, unknown> = {}, options: ServiceOptions = {}): Promise<unknown> {
    return (this.repo as { getAllMedia: (params: unknown, context?: unknown) => Promise<unknown> }).getAllMedia(
      params,
      options.context,
    );
  }

  async getById(id: string, options: ServiceOptions = {}): Promise<unknown> {
    const doc = await this.media.getById(id, options.context);
    if (!doc) {
      const err = new Error('Media not found') as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }
    return doc;
  }

  async create(data: unknown, options: ServiceOptions = {}): Promise<unknown> {
    return this.media.upload(data, options.context);
  }

  async update(id: string, data: unknown, options: ServiceOptions = {}): Promise<unknown> {
    const doc = await (
      this.repo as { updateMedia: (id: string, data: unknown, context?: unknown) => Promise<unknown> }
    ).updateMedia(id, data, options.context);
    if (!doc) {
      const err = new Error('Media not found') as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }
    return doc;
  }

  async delete(id: string, options: ServiceOptions = {}): Promise<{ success: boolean; message: string }> {
    const deleted = await this.media.delete(id, options.context);
    if (!deleted) {
      const err = new Error('Media not found') as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }
    return { success: true, message: 'Media deleted' };
  }

  // ============================================
  // Uploads
  // ============================================
  async upload(input: unknown, context?: unknown): Promise<unknown> {
    return this.media.upload(input, context);
  }

  async uploadMany(inputs: unknown[], context?: unknown): Promise<unknown[]> {
    return this.media.uploadMany(inputs, context);
  }

  // ============================================
  // Presigned uploads
  // ============================================
  async getSignedUploadUrl(
    filename: string,
    mimeType: string,
    options: Record<string, unknown> = {},
  ): Promise<unknown> {
    return this.media.getSignedUploadUrl(filename, mimeType, options);
  }

  async confirmUpload(input: unknown, context?: unknown): Promise<unknown> {
    return this.media.confirmUpload(input, context);
  }

  // ============================================
  // Bulk & folders
  // ============================================
  async deleteMany(ids: string[], context?: unknown): Promise<{ success: string[]; failed: string[] }> {
    return this.media.deleteMany(ids, context);
  }

  async move(ids: string[], targetFolder: string, context?: unknown): Promise<{ modifiedCount: number }> {
    return this.media.move(ids, targetFolder, context);
  }

  async getFolderTree(context?: unknown): Promise<unknown> {
    return this.media.getFolderTree(context);
  }

  async getFolderStats(folder: string, context?: unknown): Promise<unknown> {
    return this.media.getFolderStats(folder, context);
  }

  getBreadcrumb(folder: string): unknown {
    return this.media.getBreadcrumb(folder);
  }

  async getSubfolders(folder: string, context?: unknown): Promise<unknown> {
    return this.media.getSubfolders(folder, context);
  }

  async renameFolder(oldPath: string, newPath: string, context?: unknown): Promise<unknown> {
    return this.media.renameFolder(oldPath, newPath, context);
  }

  async deleteFolder(folder: string, context?: unknown): Promise<{ success: string[]; failed: string[] }> {
    return this.media.deleteFolder(folder, context);
  }

  // ============================================
  // Tags
  // ============================================
  async addTags(id: string, tags: string[], context?: unknown): Promise<unknown> {
    return this.media.addTags(id, tags, context);
  }

  async removeTags(id: string, tags: string[], context?: unknown): Promise<unknown> {
    return this.media.removeTags(id, tags, context);
  }
}

export default MediaService;
