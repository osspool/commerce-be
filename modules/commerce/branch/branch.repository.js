import {
  Repository,
  validationChainPlugin,
  requireField,
  uniqueField,
  cascadePlugin,
} from '@classytic/mongokit';
import Branch from './branch.model.js';
import { emitBranchUpdated, emitBranchDeleted } from '#common/events/branch.handlers.js';

/**
 * Branch Repository
 *
 * Uses MongoKit:
 * - validationChainPlugin: Required field validation
 * - cascadePlugin: Deletes related StockEntry/StockMovement on branch delete
 * - Events: Auto-filter inactive, ensure default branch exists
 */
class BranchRepository extends Repository {
  constructor() {
    super(Branch, [
      validationChainPlugin([
        requireField('code', ['create']),
        requireField('name', ['create']),
        uniqueField('code', 'Branch code already exists'),
      ]),
      cascadePlugin({
        relations: [
          { model: 'StockEntry', foreignKey: 'branch' },
          { model: 'StockMovement', foreignKey: 'branch' },
        ],
      }),
    ], {
      defaultLimit: 50,
      maxLimit: 100,
    });

    this._setupEvents();
  }

  _setupEvents() {
    // Auto-filter inactive branches
    this.on('before:getAll', (context) => {
      if (!context.includeInactive) {
        context.filters = { ...context.filters, isActive: true };
      }
    });

    // Ensure first branch becomes default and head office
    this.on('before:create', async (context) => {
      const count = await this.Model.countDocuments();
      if (count === 0) {
        context.data.isDefault = true;
        context.data.role = 'head_office';
      }
    });

    // Emit branch updated event for user sync
    this.on('after:update', ({ context, result }) => {
      const { code, name, role } = context.data || {};
      const updates = {};
      if (code !== undefined) updates.code = code;
      if (name !== undefined) updates.name = name;
      if (role !== undefined) updates.role = role;

      if (Object.keys(updates).length > 0 && result?._id) {
        emitBranchUpdated(result._id.toString(), updates);
      }
    });

    // Emit branch deleted event for user cleanup
    this.on('after:delete', ({ context, result }) => {
      if (result?._id) {
        emitBranchDeleted(result._id.toString());
      }
    });
  }

  /**
   * Get default branch, creating one if none exists
   * @returns {Promise<Object>} Default branch document
   */
  async getDefaultBranch() {
    let defaultBranch = await this.Model.findOne({ isDefault: true, isActive: true }).lean();

    if (!defaultBranch) {
      // Check if any branch exists
      const anyBranch = await this.Model.findOne({ isActive: true }).lean();

      if (anyBranch) {
        // Make existing branch the default
        await this.Model.updateOne({ _id: anyBranch._id }, { isDefault: true });
        defaultBranch = { ...anyBranch, isDefault: true };
      } else {
        // Create default branch
        defaultBranch = await this.create({
          code: 'MAIN',
          name: 'Main Store',
          type: 'store',
          isDefault: true,
          isActive: true,
        });
      }
    }

    return defaultBranch;
  }

  /**
   * Get head office branch
   * Creates one from default if no head office exists yet
   * @returns {Promise<Object>} Head office branch document
   */
  async getHeadOffice() {
    let headOffice = await this.Model.findOne({ role: 'head_office', isActive: true }).lean();

    if (!headOffice) {
      // Promote default branch to head office
      const defaultBranch = await this.getDefaultBranch();
      if (defaultBranch) {
        await this.Model.updateOne(
          { _id: defaultBranch._id },
          { role: 'head_office' }
        );
        headOffice = { ...defaultBranch, role: 'head_office' };
      }
    }

    return headOffice;
  }

  /**
   * Check if a branch is head office
   * @param {string} branchId - Branch ID to check
   * @returns {Promise<boolean>}
   */
  async isHeadOffice(branchId) {
    const branch = await this.Model.findById(branchId).select('role').lean();
    return branch?.role === 'head_office';
  }

  /**
   * Get all sub-branches (non-head-office branches)
   * @returns {Promise<Array>}
   */
  async getSubBranches() {
    return this.Model.find({ role: { $ne: 'head_office' }, isActive: true })
      .sort({ name: 1 })
      .lean();
  }

  /**
   * Set a branch as head office
   * @param {string} branchId - Branch ID to promote
   */
  async setHeadOffice(branchId) {
    return this.update(branchId, { role: 'head_office' });
  }

  /**
   * Get branch by code
   */
  async getByCode(code) {
    return this.Model.findOne({ code: code.toUpperCase(), isActive: true }).lean();
  }

  /**
   * Get all active branches
   */
  async getActiveBranches() {
    return this.Model.find({ isActive: true }).sort({ isDefault: -1, name: 1 }).lean();
  }

  /**
   * Set a branch as default
   * Note: Model hooks automatically unset other defaults when isDefault is set to true
   */
  async setDefault(branchId) {
    return this.update(branchId, { isDefault: true });
  }
}

export default new BranchRepository();
