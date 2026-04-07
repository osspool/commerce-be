import { Repository, validationChainPlugin, requireField, uniqueField } from '@classytic/mongokit';
import Supplier from './models/supplier.model.js';
import type { ISupplier } from './models/supplier.model.js';

interface RepositoryContext {
  data?: Record<string, unknown>;
}

/**
 * Supplier Repository
 *
 * Uses MongoKit validation plugins for required/unique fields.
 */
class SupplierRepository extends Repository<ISupplier> {
  constructor() {
    super(
      Supplier,
      [validationChainPlugin([requireField('name', ['create']), uniqueField('code', 'Supplier code already exists')])],
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
