import BaseController from '#common/controllers/baseController.js';
import branchRepository from './branch.repository.js';
import { branchSchemaOptions } from './branch.schemas.js';

/**
 * Branch Controller
 *
 * Extends BaseController for auto query/pagination handling.
 * Additional methods for branch-specific operations.
 */
class BranchController extends BaseController {
  constructor() {
    super(branchRepository, branchSchemaOptions);

    // Bind additional methods
    this.getByCode = this.getByCode.bind(this);
    this.getDefault = this.getDefault.bind(this);
    this.setDefault = this.setDefault.bind(this);
    this.getActive = this.getActive.bind(this);
  }

  // ============================================
  // ADDITIONAL HANDLERS
  // ============================================

  async getByCode(req, reply) {
    const { code } = req.params;
    const result = await this.service.getByCode(code);

    if (!result) {
      return reply.code(404).send({ success: false, message: 'Branch not found' });
    }

    return reply.send({ success: true, data: result });
  }

  async getDefault(req, reply) {
    const result = await this.service.getDefaultBranch();
    return reply.send({ success: true, data: result });
  }

  async setDefault(req, reply) {
    const { id } = req.params;
    const result = await this.service.setDefault(id);

    if (!result) {
      return reply.code(404).send({ success: false, message: 'Branch not found' });
    }

    return reply.send({ success: true, data: result, message: 'Default branch updated' });
  }

  async getActive(req, reply) {
    const result = await this.service.getActiveBranches();
    return reply.send({ success: true, data: result });
  }
}

export default new BranchController();
