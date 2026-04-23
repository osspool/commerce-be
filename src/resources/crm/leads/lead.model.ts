import type { LeadStatus } from '@classytic/crm';
import mongoose, { type HydratedDocument, Schema, type Types } from 'mongoose';
import { CRM_COLLECTIONS } from '../collections.js';

export interface ILeadStatusEntry {
  status: LeadStatus;
  occurredAt: Date;
  by?: string;
  note?: string;
}

export interface ILeadDoc {
  _id: Types.ObjectId;
  organizationId: string;

  firstName?: string;
  lastName?: string;
  fullName: string;
  email?: string;
  phone?: string;
  companyName?: string;
  jobTitle?: string;

  source?: string;
  campaignRef?: string;
  score?: number;

  status: LeadStatus;
  statusHistory: ILeadStatusEntry[];

  ownerId?: string;
  tags: string[];

  convertedContactId?: string;
  convertedAccountId?: string;
  convertedOpportunityId?: string;
  convertedAt?: Date;

  disqualifyReason?: string;

  metadata?: Record<string, unknown>;

  createdAt: Date;
  updatedAt: Date;
}

export type LeadDocument = HydratedDocument<ILeadDoc>;

const statusEntrySchema = new Schema<ILeadStatusEntry>(
  {
    status: { type: String, required: true },
    occurredAt: { type: Date, required: true },
    by: { type: String, trim: true },
    note: { type: String, trim: true },
  },
  { _id: false },
);

const leadSchema = new Schema<ILeadDoc>(
  {
    organizationId: { type: String, required: true, index: true },

    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    fullName: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    companyName: { type: String, trim: true },
    jobTitle: { type: String, trim: true },

    source: { type: String, trim: true },
    campaignRef: { type: String, trim: true },
    score: { type: Number, min: 0 },

    status: { type: String, required: true, default: 'new' },
    statusHistory: { type: [statusEntrySchema], default: [] },

    ownerId: { type: String, trim: true },
    tags: { type: [String], default: [] },

    convertedContactId: { type: String, trim: true },
    convertedAccountId: { type: String, trim: true },
    convertedOpportunityId: { type: String, trim: true },
    convertedAt: Date,

    disqualifyReason: { type: String, trim: true },

    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

// Dedup inbound leads by email within a branch.
leadSchema.index(
  { organizationId: 1, email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } },
);
// Pipeline dashboards: "open leads owned by rep X".
leadSchema.index({ organizationId: 1, status: 1, ownerId: 1 });
// Routing: "top-scored new leads".
leadSchema.index({ organizationId: 1, status: 1, score: -1 });

const CrmLead = mongoose.models.CrmLead || mongoose.model<ILeadDoc>('CrmLead', leadSchema, CRM_COLLECTIONS.Lead);

export default CrmLead;
