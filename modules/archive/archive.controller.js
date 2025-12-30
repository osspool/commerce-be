import BaseController from '#core/base/BaseController.js';
import archiveRepository from './archive.repository.js';
import { archiveSchemaOptions } from './schemas.js';
import fs from 'node:fs/promises';

/**
 * Archive Controller
 * Handles archive CRUD operations and file management
 *
 * Archives are created via /run endpoint, which executes archival jobs
 * and optionally deletes original records after successful archive.
 */
export class ArchiveController extends BaseController {
  constructor(service, schemaOptions) {
    super(service, schemaOptions);

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
    try {
      const archive = await archiveRepository.runArchive(
        { ...(request.validated?.body || request.body) },
        { context: request.context }
      );
      return reply.code(201).send({ success: true, data: archive });
    } catch (error) {
      return reply.code(500).send({ success: false, message: error.message });
    }
  }

  /**
   * Download archive file
   */
  async downloadArchive(request, reply) {
    try {
      const arch = await archiveRepository.getById(request.params.id, {});
      const stat = await fs.stat(arch.filePath).catch(() => null);

      if (!stat) {
        return reply.code(404).send({ success: false, message: 'Archive file not found' });
      }

      // Use reply.download if available, fallback to sendFile or path
      if (reply.download) {
        return reply.download(arch.filePath);
      } else if (reply.sendFile) {
        return reply.sendFile(arch.filePath);
      } else {
        return reply.send({ path: arch.filePath });
      }
    } catch (error) {
      return reply.code(500).send({ success: false, message: error.message });
    }
  }

  /**
   * Superadmin: Purge archive record and file
   */
  async purgeArchive(request, reply) {
    try {
      // Double-check superadmin role
      const roles = Array.isArray(request.user?.roles)
        ? request.user.roles
        : (request.user?.roles ? [request.user.roles] : []);

      if (!roles.includes('superadmin')) {
        return reply.code(403).send({ success: false, message: 'Forbidden' });
      }

      const arch = await archiveRepository.getById(request.params.id, {});

      // Delete database record
      await archiveRepository.delete(request.params.id, {});

      // Delete file (ignore errors if file doesn't exist)
      await fs.unlink(arch.filePath).catch(() => null);

      return reply.code(200).send({ success: true, message: 'Archive purged' });
    } catch (error) {
      return reply.code(500).send({ success: false, message: error.message });
    }
  }
}

const archiveController = new ArchiveController(archiveRepository, archiveSchemaOptions);
export default archiveController;
