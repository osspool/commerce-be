import mongoose, { type HydratedDocument, Schema, type Types } from 'mongoose';
import { CRM_COLLECTIONS } from '../collections.js';

export interface IAccountDoc {
  _id: Types.ObjectId;
  /** Branch scoping — `organizationId = branchId`, matches Flow convention. */
  organizationId: string;
  name: string;
  domain?: string;
  industry?: string;
  sizeBucket?: string;
  annualRevenue?: { amount: number; currency: string };
  ownerId?: string;
  tags: string[];
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export type AccountDocument = HydratedDocument<IAccountDoc>;

const accountSchema = new Schema<IAccountDoc>(
  {
    organizationId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    domain: { type: String, trim: true, lowercase: true },
    industry: { type: String, trim: true },
    sizeBucket: { type: String, trim: true },
    annualRevenue: {
      amount: { type: Number, min: 0 },
      currency: { type: String, trim: true },
    },
    ownerId: { type: String, trim: true, index: true },
    tags: { type: [String], default: [] },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

// Query: "find an account by domain within a branch" (dedup on inbound emails).
accountSchema.index(
  { organizationId: 1, domain: 1 },
  { unique: true, partialFilterExpression: { domain: { $type: 'string' } } },
);
// Query: "all accounts owned by rep X within a branch".
accountSchema.index({ organizationId: 1, ownerId: 1 });

const CrmAccount =
  mongoose.models.CrmAccount || mongoose.model<IAccountDoc>('CrmAccount', accountSchema, CRM_COLLECTIONS.Account);

export default CrmAccount;
