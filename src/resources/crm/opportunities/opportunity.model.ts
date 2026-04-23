import type { OpportunityStatus } from '@classytic/crm';
import mongoose, { type HydratedDocument, Schema, type Types } from 'mongoose';
import { CRM_COLLECTIONS } from '../collections.js';

export interface IOpportunityStatusEntry {
  status: OpportunityStatus;
  stageId?: string;
  occurredAt: Date;
  by?: string;
  note?: string;
}

export interface IOpportunityDoc {
  _id: Types.ObjectId;
  organizationId: string;

  name: string;
  accountId?: string;
  primaryContactId?: string;

  pipelineId: string;
  stageId: string;

  status: OpportunityStatus;
  statusHistory: IOpportunityStatusEntry[];

  amount?: { amount: number; currency: string };
  probability: number;
  expectedCloseAt?: Date;
  closedAt?: Date;
  lostReasonId?: string;

  ownerId?: string;
  sourceLeadId?: string;
  tags: string[];

  metadata?: Record<string, unknown>;

  createdAt: Date;
  updatedAt: Date;
}

export type OpportunityDocument = HydratedDocument<IOpportunityDoc>;

const statusEntrySchema = new Schema<IOpportunityStatusEntry>(
  {
    status: { type: String, required: true },
    stageId: { type: String, trim: true },
    occurredAt: { type: Date, required: true },
    by: { type: String, trim: true },
    note: { type: String, trim: true },
  },
  { _id: false },
);

const opportunitySchema = new Schema<IOpportunityDoc>(
  {
    organizationId: { type: String, required: true, index: true },

    name: { type: String, required: true, trim: true },
    accountId: { type: String, trim: true, index: true },
    primaryContactId: { type: String, trim: true, index: true },

    pipelineId: { type: String, required: true, index: true },
    stageId: { type: String, required: true },

    status: { type: String, required: true, default: 'open' },
    statusHistory: { type: [statusEntrySchema], default: [] },

    amount: {
      amount: { type: Number, min: 0 },
      currency: { type: String, trim: true },
    },
    probability: { type: Number, required: true, min: 0, max: 1, default: 0 },
    expectedCloseAt: Date,
    closedAt: Date,
    lostReasonId: { type: String, trim: true },

    ownerId: { type: String, trim: true, index: true },
    sourceLeadId: { type: String, trim: true },
    tags: { type: [String], default: [] },

    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

// Pipeline kanban: open deals by pipeline + stage.
opportunitySchema.index({ organizationId: 1, pipelineId: 1, status: 1, stageId: 1 });
// Rep forecast: "deals closing this quarter for rep X".
opportunitySchema.index({ organizationId: 1, ownerId: 1, expectedCloseAt: 1 });

const CrmOpportunity =
  mongoose.models.CrmOpportunity ||
  mongoose.model<IOpportunityDoc>('CrmOpportunity', opportunitySchema, CRM_COLLECTIONS.Opportunity);

export default CrmOpportunity;
