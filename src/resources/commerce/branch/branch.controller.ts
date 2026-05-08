import { type AnyRecord, BaseController } from '@classytic/arc';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IBranch } from './branch.model.js';
import branchRepository from './branch.repository.js';
import { branchSchemaOptions } from './branch.schemas.js';
import { NotFoundError } from '@classytic/arc/utils';

/**
 * Branch Controller
 *
 * Extends BaseController for auto query/pagination handling.
 * Additional methods for branch-specific operations.
 */
class BranchController extends BaseController<IBranch & AnyRecord> {
  constructor() {
    // tenantField: false matches the resource declaration — branch is
    // company-wide registry, not per-org data. Arc only threads tenantField
    // into auto-built controllers, so user-provided controllers must opt
    // out explicitly or the BaseController default ('organizationId') wins
    // and the list filter zeros out (branch docs don't carry that field).
    super(branchRepository, {
      schemaOptions: branchSchemaOptions,
      tenantField: false,
      cache: { staleTime: 30, gcTime: 180, tags: ['branches'] },
    });

    // Bind additional methods
    this.getByCode = this.getByCode.bind(this);
    this.getDefault = this.getDefault.bind(this);
    this.setDefault = this.setDefault.bind(this);
    this.getActive = this.getActive.bind(this);
  }

  // ============================================
  // ADDITIONAL HANDLERS
  // ============================================

  async getByCode(req: FastifyRequest<{ Params: { code: string } }>, reply: FastifyReply): Promise<void> {
    const { code } = req.params;
    const result = await branchRepository.getByCode(code);

    if (!result) {
      throw new NotFoundError('Branch not found');
    }

    return reply.send(result);
  }

  async getDefault(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const result = await branchRepository.getDefaultBranch();
    return reply.send(result);
  }

  async setDefault(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<void> {
    const { id } = req.params;
    const result = await branchRepository.setDefault(id);

    if (!result) {
      throw new NotFoundError('Branch not found');
    }

    return reply.send(result);
  }

  async getActive(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const result = await branchRepository.getActiveBranches();
    return reply.send(result);
  }
}

export default new BranchController();
