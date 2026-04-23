import slugPlugin from '@classytic/mongoose-slug-plugin';
import mongoose, { type HydratedDocument, type Model, Schema, type UpdateQuery } from 'mongoose';
import {
  CASH_MOVEMENT_REASON_CODES,
  SHIFT_PAYMENT_METHODS,
  type ShiftPolicy,
} from '#resources/sales/pos/shift.constants.js';

/**
 * Branch Model
 *
 * Represents a physical store/warehouse location.
 * Used for multi-location inventory tracking and POS operations.
 *
 * Every deployment must have at least one branch.
 * Default branch is created on first run if none exists.
 */

export interface IBranchAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

/**
 * Bangladesh VAT business-type regimes recognized by NBR.
 * Mirrors the `BusinessType` union exported from `@classytic/bd-tax`.
 * Each branch picks one — drives filing form, input-credit eligibility,
 * VDS withholding obligation, bonded-warehouse facility, and which GL
 * accounts the posting contracts target.
 */
export type BusinessType =
  | 'SME_TOT'
  | 'STANDARD_VAT'
  | 'IMPORTER'
  | 'RMG_EXPORTER'
  | 'IT_SERVICES'
  | 'SERVICE_PROVIDER'
  | 'COTTAGE_EXEMPT';

/**
 * Special-economic-zone status — drives utility-VAT rebate eligibility
 * (SRO-186/2023 for SEZ/BHTC) and bonded-warehouse entitlement (RMG UD/UP).
 */
export type SezStatus = 'NONE' | 'SEZ' | 'BHTC' | 'BONDED_WAREHOUSE';

export interface IBranch {
  slug?: string;
  code: string;
  name: string;
  /**
   * Per-branch POS shift policy. Resolves in this order for any given shift:
   *   shift.policySnapshot → branch.shiftPolicy → platform.defaultShiftPolicy → code defaults
   * Snapshotted onto each shift at open, so mid-shift policy changes never
   * break reconciliation math.
   */
  shiftPolicy?: Partial<ShiftPolicy>;
  /**
   * Branch **identity** — what kind of physical thing the branch is. One
   * value, mutually exclusive, describes the form-factor:
   *   - `store` / `outlet` / `franchise`: POS-capable physical retail
   *   - `warehouse`: stocking location (HO, distribution center)
   *
   * Deliberately scalar, not an array. For overlapping responsibilities
   * (a store that ALSO fulfills web orders) use the capability flags
   * below — identity stays fixed, capabilities compose.
   *
   * There is no `ecommerce` type. Web fulfillment is a capability
   * (`fulfillsEcommerce`), not an identity, because every web fulfillment
   * branch is ALSO one of the physical form-factors. Tagging a branch as
   * `type: 'ecommerce'` was the old model — replaced by the clean
   * identity-vs-capability split.
   */
  type: 'store' | 'warehouse' | 'outlet' | 'franchise';
  role: 'head_office' | 'sub_branch';
  /**
   * **Capability**: when `true`, this branch is the fulfillment target
   * for e-commerce / marketplace orders placed without an
   * `x-organization-id` header (public storefront customers don't know
   * about branches). Resolved by
   * `#resources/sales/orders/ecom-branch.ts#getEcomBranchId`.
   *
   * Exactly one active branch should have this set at a time. Not
   * enforced with a DB constraint (would deadlock flag swaps between
   * branches) — the resolver picks the first match defensively.
   */
  fulfillsEcommerce?: boolean;
  address?: IBranchAddress;
  phone?: string;
  email?: string;
  operatingHours?: string;
  isDefault: boolean;
  isActive: boolean;
  notes?: string;
  /**
   * NBR VAT regime this branch operates under. Drives filing form,
   * input-credit eligibility, VDS withholding obligation, and which GL
   * accounts posting contracts target. Default: 'STANDARD_VAT'.
   */
  businessType?: BusinessType;
  /**
   * Bonded warehouse licence / Utilization Declaration (UD) number.
   * Populated for RMG export factories and bonded importers. Required
   * for bonded-warehouse posting flows.
   */
  bondedWarehouseLicense?: string;
  /**
   * Special-economic-zone designation. Drives utility-VAT rebate
   * eligibility (SEZ/BHTC units get 80% rebate via SRO-186/2023).
   */
  sezStatus?: SezStatus;
  createdAt?: Date;
  updatedAt?: Date;
}

export type BranchDocument = HydratedDocument<IBranch>;

const branchSchema = new Schema<IBranch>(
  {
    // URL-friendly slug (auto-generated from name)
    slug: {
      type: String,
    },

    // Unique code for the branch (e.g., "DHK-1", "CTG-MAIN")
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },

    // Display name
    name: {
      type: String,
      required: true,
      trim: true,
    },

    // Branch identity — one of the four physical form-factors.
    // Capabilities (e.g. `fulfillsEcommerce`) live on separate fields.
    type: {
      type: String,
      enum: ['store', 'warehouse', 'outlet', 'franchise'],
      default: 'store',
    },

    // Branch role in inventory hierarchy
    // head_office: Can receive purchases, initiate transfers
    // sub_branch: Can only receive transfers, do local adjustments
    role: {
      type: String,
      enum: ['head_office', 'sub_branch'],
      default: 'sub_branch',
      index: true,
    },

    // E-commerce fulfillment capability. Decoupled from `type` so a
    // physical `store` can double as the web channel's fulfillment center
    // without losing its primary identity. Resolved by
    // `#resources/sales/orders/ecom-branch.ts#getEcomBranchId`.
    fulfillsEcommerce: {
      type: Boolean,
      default: false,
      index: true,
    },

    // Address
    address: {
      line1: { type: String, trim: true },
      line2: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      postalCode: { type: String, trim: true },
      country: { type: String, trim: true, default: 'Bangladesh' },
    },

    // Contact
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },

    // Operating hours (simple format)
    operatingHours: {
      type: String,
      trim: true,
      default: '10:00 AM - 10:00 PM',
    },

    // Settings
    isDefault: {
      type: Boolean,
      default: false,
      index: true,
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    // Metadata
    notes: String,

    // ─── Bangladesh VAT / NBR fields ────────────────────────────────
    // NBR VAT regime — picks filing form and posting rules. Defaults to
    // STANDARD_VAT (the common case for a retail chain). Onboarding flow
    // can set SME_TOT, RMG_EXPORTER, IT_SERVICES, etc. based on branch use.
    businessType: {
      type: String,
      enum: [
        'SME_TOT',
        'STANDARD_VAT',
        'IMPORTER',
        'RMG_EXPORTER',
        'IT_SERVICES',
        'SERVICE_PROVIDER',
        'COTTAGE_EXEMPT',
      ],
      default: 'STANDARD_VAT',
      index: true,
    },
    // Bonded-warehouse licence / UD number for RMG + bonded importers.
    bondedWarehouseLicense: {
      type: String,
      trim: true,
    },
    // SEZ / BHTC status for utility-VAT rebate calculations.
    sezStatus: {
      type: String,
      enum: ['NONE', 'SEZ', 'BHTC', 'BONDED_WAREHOUSE'],
      default: 'NONE',
    },

    // ─── POS Shift Policy (per-branch overrides) ────────────────────
    // Any field left unset falls back to platform.defaultShiftPolicy → code default.
    shiftPolicy: {
      type: new Schema(
        {
          requiredOpeningFloat: { type: Number, default: null, min: 0 },
          enforceBusinessHours: { type: Boolean, default: null },

          blindCloseRequired: { type: Boolean, default: null },
          varianceThresholdAbs: { type: Number, default: null, min: 0 },
          varianceThresholdPct: { type: Number, default: null, min: 0, max: 100 },
          managerOverrideRequired: { type: Boolean, default: null },

          autoCloseEnabled: { type: Boolean, default: null },
          // HH:mm 24h, e.g. "04:00" for a 4am late-night cutoff.
          autoCloseTime: {
            type: String,
            default: null,
            validate: {
              validator: (v: string | null) => v === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
              message: 'autoCloseTime must be HH:mm (24-hour)',
            },
          },
          autoCloseTimezone: { type: String, default: null },

          allowHandover: { type: Boolean, default: null },
          requireReasonCode: { type: Boolean, default: null },
          allowedReasonCodes: [{ type: String, enum: CASH_MOVEMENT_REASON_CODES }],
          allowedPaymentMethods: [{ type: String, enum: SHIFT_PAYMENT_METHODS }],
        },
        { _id: false },
      ),
      default: undefined,
    },
  },
  { timestamps: true },
);

// Unique slug for stable URLs (admin UI, receipts, etc.)
branchSchema.index({ slug: 1 }, { unique: true });

// Ensure only one default branch (pre-save for .save() calls)
branchSchema.pre('save', async function (this: BranchDocument) {
  if (this.isDefault && this.isModified('isDefault')) {
    await (this.constructor as Model<IBranch>).updateMany(
      { _id: { $ne: this._id }, isDefault: true },
      { isDefault: false },
    );
  }
});

// Ensure only one default branch (pre-findOneAndUpdate for update operations)
branchSchema.pre('findOneAndUpdate', async function () {
  const update = this.getUpdate() as UpdateQuery<IBranch> | null;
  const isSettingDefault = update?.isDefault === true || update?.$set?.isDefault === true;

  if (isSettingDefault) {
    const docId = this.getQuery()._id;
    await this.model.updateMany({ _id: { $ne: docId }, isDefault: true }, { isDefault: false });
  }
});

// Ensure only one default branch (pre-updateOne for updateOne operations)
branchSchema.pre('updateOne', async function () {
  const update = this.getUpdate() as UpdateQuery<IBranch> | null;
  const isSettingDefault = update?.isDefault === true || update?.$set?.isDefault === true;

  if (isSettingDefault) {
    const docId = this.getQuery()._id;
    await this.model.updateMany({ _id: { $ne: docId }, isDefault: true }, { isDefault: false });
  }
});

// Ensure only one head office (pre-save)
branchSchema.pre('save', async function (this: BranchDocument) {
  if (this.role === 'head_office' && this.isModified('role')) {
    await (this.constructor as Model<IBranch>).updateMany(
      { _id: { $ne: this._id }, role: 'head_office' },
      { role: 'sub_branch' },
    );
  }
});

// Ensure only one head office (pre-findOneAndUpdate)
branchSchema.pre('findOneAndUpdate', async function () {
  const update = this.getUpdate() as UpdateQuery<IBranch> | null;
  const isSettingHeadOffice = update?.role === 'head_office' || update?.$set?.role === 'head_office';

  if (isSettingHeadOffice) {
    const docId = this.getQuery()._id;
    await this.model.updateMany({ _id: { $ne: docId }, role: 'head_office' }, { role: 'sub_branch' });
  }
});

// Ensure only one head office (pre-updateOne)
branchSchema.pre('updateOne', async function () {
  const update = this.getUpdate() as UpdateQuery<IBranch> | null;
  const isSettingHeadOffice = update?.role === 'head_office' || update?.$set?.role === 'head_office';

  if (isSettingHeadOffice) {
    const docId = this.getQuery()._id;
    await this.model.updateMany({ _id: { $ne: docId }, role: 'head_office' }, { role: 'sub_branch' });
  }
});

// Auto-slug from name (updateOnChange: regenerate slug when name is updated)
branchSchema.plugin(slugPlugin, {
  sourceField: 'name',
  slugField: 'slug',
  updateOnChange: true,
});

// After BA migration, branches live in the `organization` collection.
// Register Branch model on `organization` collection so that:
// 1. ref: 'Branch' in other models resolves to organization docs
// 2. .populate('branch') works against organization collection
// 3. All existing branchId ObjectIds are valid (same-ID migration)
const Branch: Model<any> =
  mongoose.models.Branch || mongoose.model('Branch', new Schema({}, { strict: false, collection: 'organization' }));
export default Branch;

// Export the full schema separately for CRUD schema generation.
// The Branch model above is intentionally a strict:false stub (to coexist with BA fields),
// but we still need the field definitions to generate proper Fastify validation schemas.
export { branchSchema };
