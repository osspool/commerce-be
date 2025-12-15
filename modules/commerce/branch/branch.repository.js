import {
  Repository,
  validationChainPlugin,
  requireField,
  uniqueField,
  cascadePlugin,
} from '@classytic/mongokit';
import Branch from './branch.model.js';

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

    // Ensure first branch becomes default
    this.on('before:create', async (context) => {
      const count = await this.Model.countDocuments();
      if (count === 0) {
        context.data.isDefault = true;
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
   */
  async setDefault(branchId) {
    // Unset all defaults
    await this.Model.updateMany({ isDefault: true }, { isDefault: false });
    // Set new default
    return this.update(branchId, { isDefault: true });
  }
}

export default new BranchRepository();
