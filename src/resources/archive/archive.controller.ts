import fs from 'node:fs/promises';
import { BaseController } from '@classytic/arc';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ForbiddenError, NotFoundError } from '#shared/utils/errors.js';
import archiveRepository from './archive.repository.js';
import { archiveSchemaOptions } from './schemas.js';

interface AuthedRequest {
  user?: { role?: string | string[]; [key: string]: unknown };
}

/**
 * Archive Controller
 */
export class ArchiveController extends BaseController {
  constructor(service: typeof archiveRepository, schemaOptions: typeof archiveSchemaOptions) {
    super(service, { schemaOptions });

    this.runArchive = this.runArchive.bind(this);
    this.downloadArchive = this.downloadArchive.bind(this);
    this.purgeArchive = this.purgeArchive.bind(this);
  }

  async runArchive(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const archive = await archiveRepository.runArchive(
      (request.body || {}) as Parameters<typeof archiveRepository.runArchive>[0],
    );
    return reply.code(201).send(archive);
  }

  async downloadArchive(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<void> {
    const arch = (await archiveRepository.getById(request.params.id, {})) as unknown as Record<string, unknown>;
    const stat = await fs.stat(arch.filePath as string).catch(() => null);

    if (!stat) {
      throw new NotFoundError('Archive file not found');
    }

    const rep = reply as unknown as Record<string, unknown>;
    if (rep.download) {
      return (rep.download as (path: string) => void)(arch.filePath as string);
    } else if (rep.sendFile) {
      return (rep.sendFile as (path: string) => void)(arch.filePath as string);
    } else {
      return reply.send({ path: arch.filePath });
    }
  }

  async purgeArchive(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<void> {
    const authedReq = request as unknown as AuthedRequest;
    const roles = Array.isArray(authedReq.user?.role)
      ? authedReq.user.role
      : authedReq.user?.role
        ? [authedReq.user.role]
        : [];

    if (!roles.includes('superadmin')) {
      throw new ForbiddenError('Superadmin role required');
    }

    const arch = (await archiveRepository.getById(request.params.id, {})) as unknown as Record<string, unknown>;

    await archiveRepository.delete(request.params.id, {});

    await fs.unlink(arch.filePath as string).catch(() => null);

    return reply.send(null);
  }
}

const archiveController = new ArchiveController(archiveRepository, archiveSchemaOptions);
export default archiveController;
