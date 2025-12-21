/**
 * Media Controller
 *
 * Leverages BaseController for CRUD + media-kit for uploads/folders.
 */

import BaseController from '#common/controllers/baseController.js';
import { BASE_FOLDERS } from './media.config.js';
import { CONTENT_TYPES, mediaSchemaOptions } from './media.schemas.js';

class MediaController extends BaseController {
  /**
   * @param {import('./media.service.js').default} service - MediaService instance
   */
  constructor(service) {
    super(service, mediaSchemaOptions);

    // Bind media-specific handlers
    this.create = this.create.bind(this); // override to block generic create
    this.upload = this.upload.bind(this);
    this.uploadMultiple = this.uploadMultiple.bind(this);
    this.bulkDelete = this.bulkDelete.bind(this);
    this.moveToFolder = this.moveToFolder.bind(this);
    this.getFolders = this.getFolders.bind(this);
    this.getFolderTree = this.getFolderTree.bind(this);
    this.getFolderStats = this.getFolderStats.bind(this);
    this.getBreadcrumb = this.getBreadcrumb.bind(this);
    this.deleteFolder = this.deleteFolder.bind(this);
  }

  // Block generic create (use /upload instead)
  async create(_req, reply) {
    return reply.code(405).send({ success: false, message: 'Use /api/media/upload for creation' });
  }

  // ============================================
  // UPLOAD HANDLERS (media-kit handles heavy work)
  // ============================================
  async upload(req, reply) {
    const file = await req.file();
    if (!file) {
      return reply.code(400).send({ success: false, message: 'No file uploaded' });
    }

    const buffer = await file.toBuffer();
    const { folder = 'general', alt, title, contentType, skipProcessing } = req.body || {};

    const uploaded = await this.service.upload({
      buffer,
      filename: file.filename,
      mimeType: file.mimetype,
      folder,
      alt,
      title,
      contentType: CONTENT_TYPES.includes(contentType) ? contentType : undefined,
      skipProcessing: skipProcessing === 'true',
    }, this._buildContext(req).context);

    return reply.code(201).send({ success: true, data: uploaded });
  }

  async uploadMultiple(req, reply) {
    const parts = req.parts();
    const files = [];
    let formData = {};

    // Collect all files and form data
    for await (const part of parts) {
      if (part.type === 'file') {
        files.push({
          buffer: await part.toBuffer(),
          filename: part.filename,
          mimetype: part.mimetype,
        });
      } else {
        // Collect form fields (folder, contentType, skipProcessing)
        formData[part.fieldname] = part.value;
      }
    }

    if (!files.length) {
      return reply.code(400).send({ success: false, message: 'No files uploaded' });
    }
    if (files.length > 20) {
      return reply.code(400).send({ success: false, message: 'Max 20 files per request' });
    }

    const { folder = 'general', contentType, skipProcessing } = formData;
    const context = this._buildContext(req).context;

    const inputs = files.map((file) => ({
      buffer: file.buffer,
      filename: file.filename,
      mimeType: file.mimetype,
      folder,
      contentType: CONTENT_TYPES.includes(contentType) ? contentType : undefined,
      skipProcessing: skipProcessing === 'true',
    }));

    const uploaded = await this.service.uploadMany(inputs, context);
    return reply.code(201).send({ success: true, data: uploaded });
  }

  // ============================================
  // BULK HANDLERS
  // ============================================
  async bulkDelete(req, reply) {
    const { ids } = req.body;
    const results = await this.service.deleteMany(ids, this._buildContext(req).context);

    const statusCode = results.failed.length ? 207 : 200;
    return reply.code(statusCode).send({
      success: results.failed.length === 0,
      data: results,
      message: `Deleted ${results.success.length} of ${ids.length} files`,
    });
  }

  async moveToFolder(req, reply) {
    const { ids, targetFolder } = req.body;
    const result = await this.service.move(ids, targetFolder, this._buildContext(req).context);

    return reply.send({
      success: true,
      data: result,
      message: `Moved ${result.modifiedCount} files`,
    });
  }

  // ============================================
  // FOLDER HANDLERS
  // ============================================
  async getFolders(_req, reply) {
    return reply.send({ success: true, data: BASE_FOLDERS });
  }

  async getFolderTree(req, reply) {
    const tree = await this.service.getFolderTree(this._buildContext(req).context);
    return reply.send({ success: true, data: tree });
  }

  async getFolderStats(req, reply) {
    const stats = await this.service.getFolderStats(req.params.folder, this._buildContext(req).context);
    return reply.send({ success: true, data: stats });
  }

  async getBreadcrumb(req, reply) {
    const breadcrumb = this.service.getBreadcrumb(req.params.folder);
    return reply.send({ success: true, data: breadcrumb });
  }

  async deleteFolder(req, reply) {
    const results = await this.service.deleteFolder(req.params.folder, this._buildContext(req).context);

    if (results.success.length === 0 && results.failed.length === 0) {
      return reply.code(404).send({ success: false, message: 'No files in folder' });
    }

    const statusCode = results.failed.length ? 207 : 200;
    return reply.code(statusCode).send({
      success: results.failed.length === 0,
      data: results,
      message: `Deleted ${results.success.length} files`,
    });
  }
}

export default MediaController;