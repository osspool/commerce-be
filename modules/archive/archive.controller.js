import { BaseController } from '@classytic/arc';
import archiveRepository from './archive.repository.js';
import { archiveSchemaOptions } from './schemas.js';
import fs from 'node:fs/promises';
import { NotFoundError, ForbiddenError } from '#shared/utils/errors.js';

/**
 * Archive Controller
 * Handles archive CRUD operations and file management
 *
 * Archives are created via /run endpoint, which executes archival jobs
 * and optionally deletes original records after successful archive.
 */
export class ArchiveController extends BaseController {
  constructor(service, schemaOptions) {
    super(service, { schemaOptions });

    // Bind custom methods
    this.runArchive = this.runArchive.bind(this);
    this.downloadArchive = this.downloadArchive.bind(this);
    this.purgeArchive = this.purgeArchive.bind(this);
  }

  /**
   * Run archive job for orders or transactions
   * Creates archive file and optionally deletes originals
   */
  async runArchive(request, reply) {
    const archive = await archiveRepository.runArchive(request.body || {});
    return reply.code(201).send({ success: true, data: archive });
  }

  /**
   * Download archive file
   */
  async downloadArchive(request, reply) {
    const arch = await archiveRepository.getById(request.params.id, {});
    const stat = await fs.stat(arch.filePath).catch(() => null);

    if (!stat) {
      throw new NotFoundError('Archive file not found');
    }

    // Use reply.download if available, fallback to sendFile or path
    if (reply.download) {
      return reply.download(arch.filePath);
    } else if (reply.sendFile) {
      return reply.sendFile(arch.filePath);
    } else {
      return reply.send({ path: arch.filePath });
    }
  }

  /**
   * Superadmin: Purge archive record and file
   */
  async purgeArchive(request, reply) {
    // Double-check superadmin role
    const roles = Array.isArray(request.user?.roles)
      ? request.user.roles
      : (request.user?.roles ? [request.user.roles] : []);

    if (!roles.includes('superadmin')) {
      throw new ForbiddenError('Superadmin role required');
    }

    const arch = await archiveRepository.getById(request.params.id, {});

    // Delete database record
    await archiveRepository.delete(request.params.id, {});

    // Delete file (ignore errors if file doesn't exist)
    await fs.unlink(arch.filePath).catch(() => null);

    return reply.send({ success: true, message: 'Archive purged' });
  }
}

const archiveController = new ArchiveController(archiveRepository, archiveSchemaOptions);
export default archiveController;
