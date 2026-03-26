import {
  Repository,
  validationChainPlugin,
  requireField,
  uniqueField,
  cascadePlugin,
} from '@classytic/mongokit';
import mongoose from 'mongoose';
import { emitBranchUpdated, emitBranchDeleted } from '#shared/events/branch.handlers.js';

/**
 * Branch Repository — Now backed by BA's `organization` collection
 *
 * After the Better Auth migration, branches are stored as BA organizations.
 * This repository uses a strict:false stub model on the `organization` collection
 * (same trick as auth.config.js) to preserve the exact same API for all consumers
 * (inventory, orders, transfers, POS, etc.).
 */

// Register stub model on the `organization` collection if not already done.
// auth.config.js does the same — whichever runs first wins, both are identical.
if (!mongoose.models.organization) {
  mongoose.model('organization', new mongoose.Schema({}, { strict: false, collection: 'organization' }));
}
const OrgModel = mongoose.models.organization;

/**
 * Branch Repository
 *
 * Uses MongoKit Repository over the organization collection.
 * All existing query patterns preserved.
 */
class BranchRepository extends Repository {
  constructor() {
    super(OrgModel, [
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
        context.data.branchRole = 'head_office';
      }
      // Map 'role' to 'branchRole' for BA org schema
      if (context.data.role && !context.data.branchRole) {
        context.data.branchRole = context.data.role;
      }
    });

    // Emit branch updated event
    this.on('after:update', ({ context, result }) => {
      const { code, name, branchRole, role } = context.data || {};
      const updates = {};
      if (code !== undefined) updates.code = code;
      if (name !== undefined) updates.name = name;
      if (branchRole !== undefined) updates.role = branchRole;
      if (role !== undefined && !branchRole) updates.role = role;

      if (Object.keys(updates).length > 0 && result?._id) {
        emitBranchUpdated(result._id.toString(), updates);
      }
    });

    // Emit branch deleted event
    this.on('after:delete', ({ context, result }) => {
      if (result?._id) {
        emitBranchDeleted(result._id.toString());
      }
    });
  }

  /**
   * Get default branch, creating one if none exists
   */
  async getDefaultBranch() {
    let defaultBranch = await this.Model.findOne({ isDefault: true, isActive: true }).lean();

    if (!defaultBranch) {
      const anyBranch = await this.Model.findOne({ isActive: true }).lean();

      if (anyBranch) {
        await this.Model.updateOne({ _id: anyBranch._id }, { isDefault: true });
        defaultBranch = { ...anyBranch, isDefault: true };
      } else {
        // Create default branch as BA org
        defaultBranch = await this.create({
          code: 'MAIN',
          name: 'Main Store',
          slug: 'main-store',
          branchType: 'store',
          branchRole: 'head_office',
          isDefault: true,
          isActive: true,
        });
      }
    }

    // Normalize: expose `role` field for backward compat
    if (defaultBranch && defaultBranch.branchRole && !defaultBranch.role) {
      defaultBranch.role = defaultBranch.branchRole;
    }

    return defaultBranch;
  }

  /**
   * Get head office branch
   */
  async getHeadOffice() {
    let headOffice = await this.Model.findOne({ branchRole: 'head_office', isActive: true }).lean();

    if (!headOffice) {
      // Try old field name
      headOffice = await this.Model.findOne({ role: 'head_office', isActive: true }).lean();
    }

    if (!headOffice) {
      const defaultBranch = await this.getDefaultBranch();
      if (defaultBranch) {
        await this.Model.updateOne(
          { _id: defaultBranch._id },
          { branchRole: 'head_office' }
        );
        headOffice = { ...defaultBranch, branchRole: 'head_office', role: 'head_office' };
      }
    }

    if (headOffice && !headOffice.role) headOffice.role = headOffice.branchRole;
    return headOffice;
  }

  /**
   * Check if a branch is head office
   */
  async isHeadOffice(branchId) {
    const branch = await this.Model.findById(branchId).select('branchRole role').lean();
    return branch?.branchRole === 'head_office' || branch?.role === 'head_office';
  }

  /**
   * Get all sub-branches
   */
  async getSubBranches() {
    return this.Model.find({
      branchRole: { $ne: 'head_office' },
      isActive: true,
    }).sort({ name: 1 }).lean();
  }

  /**
   * Set a branch as head office
   */
  async setHeadOffice(branchId) {
    return this.update(branchId, { branchRole: 'head_office' });
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
    return this.update(branchId, { isDefault: true });
  }

  /**
   * Override getById to normalize role field
   */
  async getById(id) {
    const doc = await super.getById(id);
    if (doc && doc.branchRole && !doc.role) {
      doc.role = doc.branchRole;
    }
    return doc;
  }

  /**
   * Override getOne to normalize role field
   */
  async getOne(filter) {
    const doc = await this.Model.findOne(filter).lean();
    if (doc && doc.branchRole && !doc.role) {
      doc.role = doc.branchRole;
    }
    return doc;
  }
}

export default new BranchRepository();
