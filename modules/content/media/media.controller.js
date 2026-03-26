/**
 * Media Controller
 *
 * Leverages BaseController for CRUD + media-kit for uploads/folders.
 */

import { BaseController } from '@classytic/arc';
import { BASE_FOLDERS } from './media.config.js';
import { CONTENT_TYPES, mediaSchemaOptions } from './media.schemas.js';

class MediaController extends BaseController {
  /**
   * @param {import('./media.service.js').default} mediaService - MediaService instance
   */
  constructor(mediaService) {
    super(mediaService, { schemaOptions: mediaSchemaOptions });

    // Bind media-specific handlers
    this.create = this.create.bind(this); // override to block generic create
    this.upload = this.upload.bind(this);
    this.uploadMultiple = this.uploadMultiple.bind(this);
    this.getPresignedUploadUrl = this.getPresignedUploadUrl.bind(this);
    this.confirmPresignedUpload = this.confirmPresignedUpload.bind(this);
    this.bulkDelete = this.bulkDelete.bind(this);
    this.moveToFolder = this.moveToFolder.bind(this);
    this.getFolders = this.getFolders.bind(this);
    this.getFolderTree = this.getFolderTree.bind(this);
    this.getFolderStats = this.getFolderStats.bind(this);
    this.getBreadcrumb = this.getBreadcrumb.bind(this);
    this.getSubfolders = this.getSubfolders.bind(this);
    this.renameFolder = this.renameFolder.bind(this);
    this.deleteFolder = this.deleteFolder.bind(this);
    this.addTags = this.addTags.bind(this);
    this.removeTags = this.removeTags.bind(this);
  }

  // Block generic create (use /upload instead)
  async create(context) {
    return {
      success: false,
      error: 'Use /api/media/upload for creation',
      status: 405,
    };
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

    const context = { userId: req.user?.id || req.user?._id };
    if (req.user?.id) context.userId = req.user.id;

    const uploaded = await this.repository.upload({
      buffer,
      filename: file.filename,
      mimeType: file.mimetype,
      folder,
      alt,
      title,
      contentType: CONTENT_TYPES.includes(contentType) ? contentType : undefined,
      skipProcessing: skipProcessing === 'true',
    }, context);

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
    const context = { userId: req.user?.id || req.user?._id };

    const inputs = files.map((file) => ({
      buffer: file.buffer,
      filename: file.filename,
      mimeType: file.mimetype,
      folder,
      contentType: CONTENT_TYPES.includes(contentType) ? contentType : undefined,
      skipProcessing: skipProcessing === 'true',
    }));

    const uploaded = await this.repository.uploadMany(inputs, context);
    return reply.code(201).send({ success: true, data: uploaded });
  }

  // ============================================
  // PRESIGNED UPLOAD HANDLERS
  // ============================================
  async getPresignedUploadUrl(req, reply) {
    const { filename, mimeType, folder = 'general' } = req.body;

    const result = await this.repository.getSignedUploadUrl(filename, mimeType, { folder });

    return reply.send({ success: true, data: result });
  }

  async confirmPresignedUpload(req, reply) {
    const { key, filename, mimeType, size, folder, alt, title } = req.body;
    const context = { userId: req.user?.id || req.user?._id };
    if (req.user?.id) context.userId = req.user.id;

    const result = await this.repository.confirmUpload({
      key,
      filename,
      mimeType,
      size,
      folder,
      alt,
      title,
    }, context);

    return reply.code(201).send({ success: true, data: result });
  }

  // ============================================
  // BULK HANDLERS
  // ============================================
  async bulkDelete(req, reply) {
    const { ids } = req.body;
    const results = await this.repository.deleteMany(ids, { userId: req.user?.id || req.user?._id });

    const statusCode = results.failed.length ? 207 : 200;
    return reply.code(statusCode).send({
      success: results.failed.length === 0,
      data: results,
      message: `Deleted ${results.success.length} of ${ids.length} files`,
    });
  }

  async moveToFolder(req, reply) {
    const { ids, targetFolder } = req.body;
    const result = await this.repository.move(ids, targetFolder, { userId: req.user?.id || req.user?._id });

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
    const tree = await this.repository.getFolderTree({ userId: req.user?.id || req.user?._id });
    return reply.send({ success: true, data: tree });
  }

  async getFolderStats(req, reply) {
    const stats = await this.repository.getFolderStats(req.params.folder, { userId: req.user?.id || req.user?._id });
    return reply.send({ success: true, data: stats });
  }

  async getBreadcrumb(req, reply) {
    const breadcrumb = this.repository.getBreadcrumb(req.params.folder);
    return reply.send({ success: true, data: breadcrumb });
  }

  async getSubfolders(req, reply) {
    const subfolders = await this.repository.getSubfolders(req.params.folder, { userId: req.user?.id || req.user?._id });
    return reply.send({ success: true, data: subfolders });
  }

  async renameFolder(req, reply) {
    const { newName } = req.body;
    const result = await this.repository.renameFolder(req.params.folder, newName, { userId: req.user?.id || req.user?._id });
    return reply.send({ success: true, data: result });
  }

  async deleteFolder(req, reply) {
    const results = await this.repository.deleteFolder(req.params.folder, { userId: req.user?.id || req.user?._id });

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

  // ============================================
  // TAG HANDLERS
  // ============================================
  async addTags(req, reply) {
    const result = await this.repository.addTags(req.params.id, req.body.tags, { userId: req.user?.id || req.user?._id });
    return reply.send({ success: true, data: result });
  }

  async removeTags(req, reply) {
    const result = await this.repository.removeTags(req.params.id, req.body.tags, { userId: req.user?.id || req.user?._id });
    return reply.send({ success: true, data: result });
  }
}

export default MediaController;