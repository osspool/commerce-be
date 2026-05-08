import mongoose, { type HydratedDocument, type Model, Schema } from 'mongoose';
import { InventoryCounter } from '../../flow/counter-bridge.js';

export const SupplierType = Object.freeze({
  LOCAL: 'local',
  IMPORT: 'import',
  MANUFACTURER: 'manufacturer',
  WHOLESALER: 'wholesaler',
} as const);

export type SupplierTypeValue = (typeof SupplierType)[keyof typeof SupplierType];

export const PaymentTerms = Object.freeze({
  CASH: 'cash',
  CREDIT: 'credit',
} as const);

export type PaymentTermsValue = (typeof PaymentTerms)[keyof typeof PaymentTerms];

export interface ISupplier {
  name: string;
  nameNormalized?: string;
  code?: string;
  type: SupplierTypeValue;
  contactPerson?: string;
  phone?: string;
  email?: string;
  address?: string;
  taxId?: string;
  paymentTerms: PaymentTermsValue;
  creditDays: number;
  creditLimit: number;
  openingBalance: number;
  isActive: boolean;
  notes?: string;
  tags: string[];
  // ─── Bangladesh VAT / NBR fields ───────────────────────────────────
  /** BIN (13-digit) — required for VAT-registered suppliers */
  bin?: string;
  /** Fiscal position code on purchase side (usually NATIONAL or INTERNATIONAL for imports) */
  fiscalPositionCode?: string | null;
  /**
   * Supplier charges a truncated rate (5% / 7.5% / 10%). Per NBR we cannot
   * claim input credit on these — the tax folds into inventory cost. This
   * flag ensures the posting contract does the right thing even if the
   * rate lookup is ambiguous.
   */
  isTruncatedRateSupplier?: boolean;
  /**
   * This supplier delivers into our bonded warehouse (RMG raw material
   * scenario). VAT is deferred — the posting uses 1150.VAT0.INPUT and
   * doesn't release input credit until goods exit bond into DTA sale.
   */
  bondedWarehouseSupplier?: boolean;
  /**
   * ISO country code — 'BD' for domestic, anything else flags this as an
   * import supplier for customs-clearance handling.
   */
  countryCode?: string | null;
  /**
   * True when we must deduct VDS (VAT Deducted at Source) from payments to
   * this supplier. Per BD VAT Act, designated withholding entities must hold
   * back the VDS portion and remit directly to NBR. When set, the vendor-bill
   * posting splits A/P: `Cr 2111 A/P (net)` + `Cr 2136 VDS Payable (VDS portion)`.
   */
  withholdVds?: boolean;
  /**
   * Fraction of the input VAT to withhold as VDS. Defaults to 0.5 (50%)
   * per NBR SRO-254-AIN/2019/MUSAK-11. Only relevant when `withholdVds=true`.
   */
  vdsRate?: number;
  createdBy?: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
  /**
   * Soft-delete marker managed by mongokit's `softDeletePlugin` on the
   * repository. `null` = live, `Date` = archived. List / get queries
   * filter `deletedAt: null` by default; `getDeleted()` / `restore()`
   * on the repo surface archived docs.
   */
  deletedAt?: Date | null;
}

export type SupplierDocument = HydratedDocument<ISupplier>;

interface SupplierModel extends Model<ISupplier> {
  generateCode(): Promise<string>;
}

const supplierSchema = new Schema<ISupplier, SupplierModel>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    nameNormalized: {
      type: String,
      trim: true,
      lowercase: true,
    },
    code: {
      type: String,
      trim: true,
      uppercase: true,
    },
    type: {
      type: String,
      enum: Object.values(SupplierType),
      default: SupplierType.LOCAL,
    },
    contactPerson: {
      type: String,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
    },
    address: {
      type: String,
      trim: true,
    },
    taxId: {
      type: String,
      trim: true,
    },
    paymentTerms: {
      type: String,
      enum: Object.values(PaymentTerms),
      default: PaymentTerms.CASH,
    },
    creditDays: {
      type: Number,
      default: 0,
      min: 0,
    },
    creditLimit: {
      type: Number,
      min: 0,
      default: 0,
    },
    openingBalance: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    notes: {
      type: String,
      trim: true,
    },
    tags: {
      type: [String],
      default: [],
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },

    // ─── Bangladesh VAT / NBR fields ───────────────────────────────
    bin: {
      type: String,
      trim: true,
      validate: {
        validator: (v: string) => !v || /^\d{13}$/.test(v),
        message: 'BIN must be 13 digits',
      },
      index: true,
      sparse: true,
    },
    fiscalPositionCode: {
      // `null` is included so the AJV-validated create body accepts the
      // mongoose-applied default (`default: null`). Without it, mongokit's
      // generated schema rejects the auto-defaulted `null` as an enum miss.
      type: String,
      enum: ['NATIONAL', 'INTERNATIONAL', null],
      default: null,
    },
    isTruncatedRateSupplier: { type: Boolean, default: false },
    bondedWarehouseSupplier: { type: Boolean, default: false },
    countryCode: { type: String, trim: true, default: null },
    withholdVds: { type: Boolean, default: false },
    vdsRate: { type: Number, default: 0.5, min: 0, max: 1 },
    // softDeletePlugin needs the field declared with `default: null` so
    // newly-created docs match the `{ deletedAt: null }` filter (default
    // `filterMode: 'null'`). See supplier.repository.ts.
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

supplierSchema.index({ name: 1, isActive: 1 });
supplierSchema.index({ code: 1 }, { unique: true, sparse: true });
supplierSchema.index({ nameNormalized: 1 }, { unique: true, partialFilterExpression: { isActive: true } });

/**
 * Generate supplier code: SUP-0001
 */
supplierSchema.statics.generateCode = async (): Promise<string> => {
  const prefix = 'SUP-';
  const sequence = await InventoryCounter.nextSeq('SUP', 'ALL');
  return `${prefix}${String(sequence).padStart(4, '0')}`;
};

const Supplier: SupplierModel =
  (mongoose.models.Supplier as SupplierModel) || mongoose.model<ISupplier, SupplierModel>('Supplier', supplierSchema);
export default Supplier;
