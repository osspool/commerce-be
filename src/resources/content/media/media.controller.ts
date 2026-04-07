/**
 * Media Controller
 *
 * Leverages BaseController for CRUD + media-kit for uploads/folders.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { BaseController } from '@classytic/arc';
import type { RepositoryLike } from '@classytic/arc';
import { BASE_FOLDERS } from './media.config.js';
import { CONTENT_TYPES, mediaSchemaOptions } from './media.schemas.js';
import type MediaService from './media.service.js';

interface AuthedRequest {
  user?: { id?: string; _id?: string };
  body?: unknown;
  params?: unknown;
  [key: string]: unknown;
}

interface MultipartFile {
  filename: string;
  mimetype: string;
  toBuffer: () => Promise<Buffer>;
}

interface MultipartPart {
  type: 'file' | 'field';
  filename?: string;
  mimetype?: string;
  fieldname?: string;
  value?: string;
  toBuffer?: () => Promise<Buffer>;
}

class MediaController extends BaseController {
  protected declare repository: RepositoryLike & MediaService;
  constructor(mediaService: MediaService) {
    // MediaService satisfies RepositoryLike (getAll, getById, create, update, delete)
    super(mediaService as unknown as RepositoryLike, { schemaOptions: mediaSchemaOptions });

    // Bind media-specific handlers
    this.create = this.create.bind(this);
    this.upload = this.upload.bind(this);
    this.uploadMultiple = this.uploadMultiple.bind(this);
    this.getPresignedUploadUrl = this.getPresignedUploadUrl.bind(this);
    this.confirmPresignedUpload = this.confirmPresignedUpload.bind(this);
    this.bulkDeleteMedia = this.bulkDeleteMedia.bind(this);
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
  async create(_context?: unknown): Promise<any> {
    return {
      success: false,
      error: 'Use /api/media/upload for creation',
      status: 405,
    };
  }

  // ============================================
  // UPLOAD HANDLERS (media-kit handles heavy work)
  // ============================================
  async upload(req: AuthedRequest, reply: FastifyReply): Promise<void> {
    const file = await (req as unknown as { file: () => Promise<MultipartFile | null> }).file();
    if (!file) {
      return reply.code(400).send({ success: false, message: 'No file uploaded' });
    }

    const buffer = await file.toBuffer();
    const { folder = 'general', alt, title, contentType, skipProcessing } = (req.body || {}) as Record<string, string>;

    const context: Record<string, unknown> = { userId: req.user?.id || req.user?._id };
    if (req.user?.id) context.userId = req.user.id;

    const uploaded = await this.repository.upload(
      {
        buffer,
        filename: file.filename,
        mimeType: file.mimetype,
        folder,
        alt,
        title,
        contentType: CONTENT_TYPES.includes(contentType) ? contentType : undefined,
        skipProcessing: skipProcessing === 'true',
      },
      context,
    );

    return reply.code(201).send({ success: true, data: uploaded });
  }

  async uploadMultiple(req: AuthedRequest, reply: FastifyReply): Promise<void> {
    const parts = (req as unknown as { parts: () => AsyncIterable<MultipartPart> }).parts();
    const files: Array<{ buffer: Buffer; filename: string; mimetype: string }> = [];
    const formData: Record<string, string> = {};

    for await (const part of parts) {
      if (part.type === 'file' && part.toBuffer) {
        files.push({
          buffer: await part.toBuffer(),
          filename: part.filename as string,
          mimetype: part.mimetype as string,
        });
      } else {
        formData[part.fieldname as string] = part.value as string;
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
  async getPresignedUploadUrl(req: AuthedRequest, reply: FastifyReply): Promise<void> {
    const {
      filename,
      mimeType,
      folder = 'general',
    } = req.body as { filename: string; mimeType: string; folder?: string };

    const result = await this.repository.getSignedUploadUrl(filename, mimeType, { folder });

    return reply.send({ success: true, data: result });
  }

  async confirmPresignedUpload(req: AuthedRequest, reply: FastifyReply): Promise<void> {
    const { key, filename, mimeType, size, folder, alt, title } = req.body as Record<string, unknown>;
    const context: Record<string, unknown> = { userId: req.user?.id || req.user?._id };
    if (req.user?.id) context.userId = req.user.id;

    const result = await this.repository.confirmUpload(
      {
        key,
        filename,
        mimeType,
        size,
        folder,
        alt,
        title,
      },
      context,
    );

    return reply.code(201).send({ success: true, data: result });
  }

  // ============================================
  // BULK HANDLERS
  // ============================================
  async bulkDeleteMedia(req: AuthedRequest, reply: FastifyReply): Promise<void> {
    const { ids } = req.body as { ids: string[] };
    const results = await this.repository.deleteMany(ids, { userId: req.user?.id || req.user?._id });

    const statusCode = results.failed.length ? 207 : 200;
    return reply.code(statusCode).send({
      success: results.failed.length === 0,
      data: results,
      message: `Deleted ${results.success.length} of ${ids.length} files`,
    });
  }

  async moveToFolder(req: AuthedRequest, reply: FastifyReply): Promise<void> {
    const { ids, targetFolder } = req.body as { ids: string[]; targetFolder: string };
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
  async getFolders(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    return reply.send({ success: true, data: BASE_FOLDERS });
  }

  async getFolderTree(req: AuthedRequest, reply: FastifyReply): Promise<void> {
    const tree = await this.repository.getFolderTree({ userId: req.user?.id || req.user?._id });
    return reply.send({ success: true, data: tree });
  }

  async getFolderStats(
    req: AuthedRequest & FastifyRequest<{ Params: { folder: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const stats = await this.repository.getFolderStats(req.params.folder, { userId: req.user?.id || req.user?._id });
    return reply.send({ success: true, data: stats });
  }

  async getBreadcrumb(req: FastifyRequest<{ Params: { folder: string } }>, reply: FastifyReply): Promise<void> {
    const breadcrumb = this.repository.getBreadcrumb(req.params.folder);
    return reply.send({ success: true, data: breadcrumb });
  }

  async getSubfolders(
    req: AuthedRequest & FastifyRequest<{ Params: { folder: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const subfolders = await this.repository.getSubfolders(req.params.folder, {
      userId: req.user?.id || req.user?._id,
    });
    return reply.send({ success: true, data: subfolders });
  }

  async renameFolder(
    req: AuthedRequest & FastifyRequest<{ Params: { folder: string }; Body: { newName: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { newName } = req.body;
    const result = await this.repository.renameFolder(req.params.folder, newName, {
      userId: req.user?.id || req.user?._id,
    });
    return reply.send({ success: true, data: result });
  }

  async deleteFolder(
    req: AuthedRequest & FastifyRequest<{ Params: { folder: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
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
  async addTags(
    req: AuthedRequest & FastifyRequest<{ Params: { id: string }; Body: { tags: string[] } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const result = await this.repository.addTags(req.params.id, req.body.tags, {
      userId: req.user?.id || req.user?._id,
    });
    return reply.send({ success: true, data: result });
  }

  async removeTags(
    req: AuthedRequest & FastifyRequest<{ Params: { id: string }; Body: { tags: string[] } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const result = await this.repository.removeTags(req.params.id, req.body.tags, {
      userId: req.user?.id || req.user?._id,
    });
    return reply.send({ success: true, data: result });
  }
}

export default MediaController;
