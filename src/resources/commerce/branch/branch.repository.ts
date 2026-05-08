import { Repository, requireField, uniqueField, validationChainPlugin } from '@classytic/mongokit';
import mongoose from 'mongoose';
import type { IBranch } from './branch.model.js';

/**
 * Branch Repository — Now backed by BA's `organization` collection
 *
 * After the Better Auth migration, branches are stored as BA organizations.
 * This repository uses a strict:false stub model on the `organization` collection
 * (same trick as auth.config.js) to preserve the exact same API for all consumers
 * (inventory, orders, transfers, POS, etc.).
 */

// BA organization doc shape (superset of IBranch with BA-specific fields)
interface IBranchOrg extends IBranch {
  _id?: string | mongoose.Types.ObjectId;
  branchRole?: string;
  branchType?: string;
  [key: string]: unknown;
}

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
class BranchRepository extends Repository<IBranchOrg> {
  constructor() {
    super(
      OrgModel,
      [
        validationChainPlugin([
          requireField('code', ['create']),
          requireField('name', ['create']),
          uniqueField('code', 'Branch code already exists'),
        ]),
        // Note: StockEntry/StockMovement models were removed — stock is now
        // managed by @classytic/flow (quants, moves, moveGroups). Flow data
        // is scoped by organizationId (= branchId), not a FK cascade target.
        // No cascade needed — Flow handles its own cleanup per org scope.
      ],
      {
        defaultLimit: 50,
        maxLimit: 100,
      },
    );

    this._setupEvents();
  }

  private _setupEvents(): void {
    // Auto-filter inactive branches
    this.on('before:getAll', (context: Record<string, any>) => {
      if (!context.includeInactive) {
        context.filters = { ...context.filters, isActive: true };
      }
    });

    // Ensure first branch becomes default and head office
    this.on('before:create', async (context: Record<string, any>) => {
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
  }

  /**
   * Get default branch, creating one if none exists
   */
  async getDefaultBranch(): Promise<IBranchOrg> {
    let defaultBranch: any = await this.getByQuery({ isDefault: true, isActive: true });

    if (!defaultBranch) {
      const anyBranch = await this.getByQuery({ isActive: true });

      if (anyBranch) {
        await this.update(String(anyBranch._id), { isDefault: true });
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
    if (defaultBranch?.branchRole && !defaultBranch.role) {
      defaultBranch.role = defaultBranch.branchRole;
    }

    return defaultBranch;
  }

  /**
   * Get head office branch
   */
  async getHeadOffice(): Promise<IBranchOrg | null> {
    let headOffice: any = await this.getByQuery({ branchRole: 'head_office', isActive: true });

    if (!headOffice) {
      // Try old field name
      headOffice = await this.getByQuery({ role: 'head_office', isActive: true });
    }

    if (!headOffice) {
      const defaultBranch = await this.getDefaultBranch();
      if (defaultBranch) {
        await this.update(String(defaultBranch._id), { branchRole: 'head_office' });
        headOffice = { ...defaultBranch, branchRole: 'head_office', role: 'head_office' };
      }
    }

    if (headOffice && !headOffice.role) headOffice.role = headOffice.branchRole;
    return headOffice;
  }

  /**
   * Check if a branch is head office
   */
  async isHeadOffice(branchId: string): Promise<boolean> {
    const branch: any = await this.getById(branchId);
    return branch?.branchRole === 'head_office' || branch?.role === 'head_office';
  }

  /**
   * Get all sub-branches
   */
  async getSubBranches(): Promise<IBranchOrg[]> {
    return this.findAll(
      {
        branchRole: { $ne: 'head_office' },
        isActive: true,
      },
      { sort: { name: 1 } },
    ) as Promise<IBranchOrg[]>;
  }

  /**
   * Set a branch as head office
   */
  async setHeadOffice(branchId: string): Promise<unknown> {
    return this.update(branchId, { branchRole: 'head_office' });
  }

  /**
   * Get branch by code.
   *
   * Mongoose `strictQuery` strips filter keys that aren't declared in the
   * schema. The OrgModel here uses an empty stub schema (`new Schema({},
   * { strict: false })`), so a stricter Mongoose default at the connection
   * level can silently drop `code` from the query, falling back to
   * `findOne({ isActive: true })` and returning the first active org.
   * Drop into the raw collection to keep the filter intact.
   */
  async getByCode(code: string): Promise<IBranchOrg | null> {
    const collection = this.Model.collection;
    const result = await collection.findOne({ code: code.toUpperCase(), isActive: true });
    return result as IBranchOrg | null;
  }

  /**
   * Get all active branches
   */
  async getActiveBranches(): Promise<IBranchOrg[]> {
    return this.findAll({ isActive: true }, { sort: { isDefault: -1, name: 1 } }) as Promise<IBranchOrg[]>;
  }

  /**
   * Set a branch as default
   */
  async setDefault(branchId: string): Promise<unknown> {
    return this.update(branchId, { isDefault: true });
  }

  /**
   * Override getById to normalize role field. Forwards mongokit options
   * (`select`, `lean`, `throwOnNotFound`, `cache`) to the base implementation
   * — narrowing the signature here would block consumers from using the
   * standard repository contract.
   */
  async getById(id: string | mongoose.Types.ObjectId, options?: Record<string, unknown>): Promise<any> {
    const doc: any = await super.getById(id as string, options);
    if (doc?.branchRole && !doc.role) {
      doc.role = doc.branchRole;
    }
    return doc;
  }

  /**
   * Override getOne to normalize role field
   */
  async getOne(filter: Record<string, unknown>): Promise<any> {
    const doc: any = await this.Model.findOne(filter).lean();
    if (doc?.branchRole && !doc.role) {
      doc.role = doc.branchRole;
    }
    return doc;
  }
}

export default new BranchRepository();
