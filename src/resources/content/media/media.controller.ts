/**
 * Media Controller
 *
 * Extends Arc's BaseController for generic CRUD (list, get, update) and
 * adds raw routes for upload / folder / tag / bulk operations that call
 * the v3 MediaRepository domain verbs directly.
 */

import type { IControllerResponse, IRequestContext } from '@classytic/arc';
import { BaseController } from '@classytic/arc';
import type { MediaRepository } from '@classytic/media-kit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { BASE_FOLDERS } from './media.config.js';
import { CONTENT_TYPES, mediaSchemaOptions } from './media.schemas.js';
import { createError, NotFoundError, ValidationError } from '@classytic/arc/utils';

type ContentType = (typeof CONTENT_TYPES)[number];

function pickContentType(value: string | undefined): ContentType | undefined {
  return value && (CONTENT_TYPES as readonly string[]).includes(value) ? (value as ContentType) : undefined;
}

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
  private readonly repo: MediaRepository;

  constructor(repo: MediaRepository) {
    // MediaRepository extends mongokit Repository<T>, which already
    // satisfies RepositoryLike. We override `delete` below to route through
    // hardDelete so storage objects are cleaned up alongside the doc.
    //
    // `tenantField: false` — media library is company-wide (shared across
    // every branch). Without this, BaseController defaults to
    // `'organizationId'` and QueryResolver stamps `{organizationId: <scope>}`
    // into list filters, excluding every row.
    super(repo, { schemaOptions: mediaSchemaOptions, tenantField: false });
    this.repo = repo;

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

  // Block generic create — uploads must go through /upload (buffer required).
  // biome-ignore lint/suspicious/noExplicitAny: arc handler return type
  async create(_context?: unknown): Promise<any> {
    throw createError(405, 'Use /api/media/upload for creation');
  }

  // Override the inherited DELETE /:id handler so it routes through
  // `hardDelete` — that's the domain verb that also drops storage objects.
  // The signature must match BaseController.delete (single IRequestContext).
  async delete(req: IRequestContext): Promise<IControllerResponse<{ message: string; id: string }>> {
    const id = req.params?.id;
    if (!id) throw new ValidationError('ID parameter is required');

    const user = req.user as { id?: string; _id?: string } | undefined;
    const ctx = { userId: user?.id ?? user?._id };
    const ok = await this.repo.hardDelete(id, ctx as never);
    if (!ok) throw new NotFoundError('Media');
    return { data: { message: 'Media deleted', id } };
  }

  // ─── Upload handlers ────────────────────────────────────────
  async upload(req: AuthedRequest, reply: FastifyReply): Promise<void> {
    const file = await (req as unknown as { file: () => Promise<MultipartFile | null> }).file();
    if (!file) throw new ValidationError('No file uploaded');

    const buffer = await file.toBuffer();
    const { folder = 'general', alt, title, contentType, skipProcessing } = (req.body ?? {}) as Record<string, string>;

    const ctx = { userId: req.user?.id ?? req.user?._id };
    const uploaded = await this.repo.upload(
      {
        buffer,
        filename: file.filename,
        mimeType: file.mimetype,
        folder,
        alt,
        title,
        contentType: pickContentType(contentType),
        skipProcessing: skipProcessing === 'true',
      } as never,
      ctx as never,
    );
    return reply.code(201).send(uploaded);
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

    if (!files.length) throw new ValidationError('No files uploaded');
    if (files.length > 20) throw new ValidationError('Max 20 files per request');

    const { folder = 'general', contentType, skipProcessing } = formData;
    const ctx = { userId: req.user?.id ?? req.user?._id };
    const inputs = files.map((f) => ({
      buffer: f.buffer,
      filename: f.filename,
      mimeType: f.mimetype,
      folder,
      contentType: pickContentType(contentType),
      skipProcessing: skipProcessing === 'true',
    }));

    const uploaded = await this.repo.uploadMany(inputs as never, ctx as never);
    return reply.code(201).send(uploaded);
  }

  // ─── Presigned uploads ──────────────────────────────────────
  async getPresignedUploadUrl(req: AuthedRequest, reply: FastifyReply): Promise<void> {
    const {
      filename,
      mimeType,
      folder = 'general',
    } = req.body as {
      filename: string;
      mimeType: string;
      folder?: string;
    };
    const result = await this.repo.getSignedUploadUrl(filename, mimeType, { folder } as never);
    return reply.send(result);
  }

  async confirmPresignedUpload(req: AuthedRequest, reply: FastifyReply): Promise<void> {
    const { key, filename, mimeType, size, folder, alt, title } = req.body as Record<string, unknown>;
    const ctx = { userId: req.user?.id ?? req.user?._id };
    const result = await this.repo.confirmUpload(
      { key, filename, mimeType, size, folder, alt, title } as never,
      ctx as never,
    );
    return reply.code(201).send(result);
  }

  // ─── Bulk handlers ──────────────────────────────────────────
  async bulkDeleteMedia(req: AuthedRequest, reply: FastifyReply): Promise<void> {
    const { ids } = req.body as { ids: string[] };
    const ctx = { userId: req.user?.id ?? req.user?._id };
    const results = await this.repo.hardDeleteMany(ids, ctx as never);
    const failed = results.failed ?? [];
    const success = results.success ?? [];
    const statusCode = failed.length ? 207 : 200;
    return reply.code(statusCode).send({
      success,
      failed,
      message: `Deleted ${success.length} of ${ids.length} files`,
    });
  }

  async moveToFolder(req: AuthedRequest, reply: FastifyReply): Promise<void> {
    const { ids, targetFolder } = req.body as { ids: string[]; targetFolder: string };
    const ctx = { userId: req.user?.id ?? req.user?._id };
    const result = await this.repo.move(ids, targetFolder, ctx as never);
    return reply.send({
      ...result,
      message: `Moved ${result.modifiedCount ?? 0} files`,
    });
  }

  // ─── Folder handlers ────────────────────────────────────────
  async getFolders(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    return reply.send(BASE_FOLDERS);
  }

  async getFolderTree(req: AuthedRequest, reply: FastifyReply): Promise<void> {
    const ctx = { userId: req.user?.id ?? req.user?._id };
    const tree = await this.repo.getFolderTree(ctx as never);
    return reply.send(tree);
  }

  async getFolderStats(
    req: AuthedRequest & FastifyRequest<{ Params: { folder: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const ctx = { userId: req.user?.id ?? req.user?._id };
    const stats = await this.repo.getFolderStats(req.params.folder, ctx as never);
    return reply.send(stats);
  }

  async getBreadcrumb(req: FastifyRequest<{ Params: { folder: string } }>, reply: FastifyReply): Promise<void> {
    const breadcrumb = this.repo.getBreadcrumb(req.params.folder);
    return reply.send(breadcrumb);
  }

  async getSubfolders(
    req: AuthedRequest & FastifyRequest<{ Params: { folder: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const ctx = { userId: req.user?.id ?? req.user?._id };
    const subfolders = await this.repo.getSubfolders(req.params.folder, ctx as never);
    return reply.send(subfolders);
  }

  async renameFolder(
    req: AuthedRequest & FastifyRequest<{ Params: { folder: string }; Body: { newName: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const ctx = { userId: req.user?.id ?? req.user?._id };
    const result = await this.repo.renameFolder(req.params.folder, req.body.newName, ctx as never);
    return reply.send(result);
  }

  async deleteFolder(
    req: AuthedRequest & FastifyRequest<{ Params: { folder: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const ctx = { userId: req.user?.id ?? req.user?._id };
    const results = await this.repo.deleteFolder(req.params.folder, ctx as never);
    const failed = results.failed ?? [];
    const success = results.success ?? [];

    if (success.length === 0 && failed.length === 0) {
      throw new NotFoundError('No files in folder');
    }
    const statusCode = failed.length ? 207 : 200;
    return reply.code(statusCode).send({
      success: failed.length === 0,
      data: { success, failed },
      message: `Deleted ${success.length} files`,
    });
  }

  // ─── Tag handlers ───────────────────────────────────────────
  async addTags(
    req: AuthedRequest & FastifyRequest<{ Params: { id: string }; Body: { tags: string[] } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const ctx = { userId: req.user?.id ?? req.user?._id };
    const result = await this.repo.addTags(req.params.id, req.body.tags, ctx as never);
    return reply.send(result);
  }

  async removeTags(
    req: AuthedRequest & FastifyRequest<{ Params: { id: string }; Body: { tags: string[] } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const ctx = { userId: req.user?.id ?? req.user?._id };
    const result = await this.repo.removeTags(req.params.id, req.body.tags, ctx as never);
    return reply.send(result);
  }
}

export default MediaController;
