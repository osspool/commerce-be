import {
  Repository,
  requireField,
  softDeletePlugin,
  uniqueField,
  validationChainPlugin,
} from '@classytic/mongokit';
import type { ISupplier } from './models/supplier.model.js';
import Supplier from './models/supplier.model.js';

interface RepositoryContext {
  data?: Record<string, unknown>;
}

/**
 * Supplier Repository
 *
 * - `validationChainPlugin` — required `name`, unique `code`.
 * - `softDeletePlugin` — DELETE sets `deletedAt` and filters the doc out
 *   of list / get responses. Historical purchase docs still populate the
 *   supplier name because direct Mongoose populate bypasses the plugin
 *   filter (intentional — the A/P ledger must still render the vendor
 *   even after the vendor record is archived). `isActive` remains a
 *   separate business flag for "temporarily not ordering".
 */
class SupplierRepository extends Repository<ISupplier> {
  constructor() {
    super(
      Supplier,
      [
        validationChainPlugin([
          requireField('name', ['create']),
          uniqueField('code', 'Supplier code already exists'),
        ]),
        softDeletePlugin(),
      ],
      {
        defaultLimit: 20,
        maxLimit: 100,
      },
    );

    this._setupEvents();
  }

  private _setupEvents(): void {
    const normalizeName = (name: unknown): string | null => {
      if (name == null) return null;
      return String(name).trim().toLowerCase();
    };

    this.on('before:create', async (context: RepositoryContext) => {
      if (!context?.data) return;
      if (!context.data.code) {
        context.data.code = await (this.Model as unknown as { generateCode(): Promise<string> }).generateCode();
      }
      if (context.data.name) {
        context.data.name = String(context.data.name).trim();
        context.data.nameNormalized = normalizeName(context.data.name);
      }
    });

    this.on('before:update', async (context: RepositoryContext) => {
      if (!context?.data) return;
      if (context.data.name) {
        context.data.name = String(context.data.name).trim();
        context.data.nameNormalized = normalizeName(context.data.name);
      }
    });
  }

  async backfillNameNormalized(): Promise<{ modifiedCount: number }> {
    const result = await this.Model.updateMany(
      { $or: [{ nameNormalized: { $exists: false } }, { nameNormalized: null }, { nameNormalized: '' }] },
      [
        {
          $set: {
            nameNormalized: {
              $toLower: { $trim: { input: '$name' } },
            },
          },
        },
      ],
    );
    return { modifiedCount: result.modifiedCount || 0 };
  }
}

export default new SupplierRepository();
