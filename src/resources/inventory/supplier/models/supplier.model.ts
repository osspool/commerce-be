import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';
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
  createdBy?: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
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
