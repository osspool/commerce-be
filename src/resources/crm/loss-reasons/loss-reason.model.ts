import mongoose, { type HydratedDocument, Schema, type Types } from 'mongoose';
import { CRM_COLLECTIONS } from '../collections.js';

export interface ILossReasonDoc {
  _id: Types.ObjectId;
  organizationId: string;

  name: string;
  category?: string;
  description?: string;
  active: boolean;

  metadata?: Record<string, unknown>;

  createdAt: Date;
  updatedAt: Date;
}

export type LossReasonDocument = HydratedDocument<ILossReasonDoc>;

const lossReasonSchema = new Schema<ILossReasonDoc>(
  {
    organizationId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, trim: true },
    description: { type: String, trim: true },
    active: { type: Boolean, default: true },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

// Seed picker: "active loss reasons for a branch".
lossReasonSchema.index({ organizationId: 1, active: 1 });
// Admin uniqueness — no two active reasons with the same name.
lossReasonSchema.index({ organizationId: 1, name: 1 }, { unique: true, partialFilterExpression: { active: true } });

const CrmLossReason =
  mongoose.models.CrmLossReason ||
  mongoose.model<ILossReasonDoc>('CrmLossReason', lossReasonSchema, CRM_COLLECTIONS.LossReason);

export default CrmLossReason;
