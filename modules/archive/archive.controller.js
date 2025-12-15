import BaseController from '#common/controllers/baseController.js';
import archiveRepository from './archive.repository.js';
import { archiveSchemaOptions } from './schemas.js';

/**
 * Archive Controller
 * Handles archive CRUD operations and file management
 *
 * Note: Archive creation happens via /run endpoint
 * This controller handles viewing, downloading, and purging archives
 */
export class ArchiveController extends BaseController {
  constructor(service, schemaOptions) {
    super(service, schemaOptions);
  }
}

const archiveController = new ArchiveController(archiveRepository, archiveSchemaOptions);
export default archiveController;
