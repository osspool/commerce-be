import type { ActivityStatus, SubjectKind } from '@classytic/crm';
import mongoose, { type HydratedDocument, Schema, type Types } from 'mongoose';
import { CRM_COLLECTIONS } from '../collections.js';

export interface IActivityDoc {
  _id: Types.ObjectId;
  organizationId: string;

  type: string;
  status: ActivityStatus;

  subjectKind: SubjectKind;
  subjectId: string;

  subject?: string;
  body?: string;

  scheduledAt?: Date;
  completedAt?: Date;
  cancelledAt?: Date;

  ownerId?: string;
  participantIds: string[];

  externalRef?: string;

  metadata?: Record<string, unknown>;

  createdAt: Date;
  updatedAt: Date;
}

export type ActivityDocument = HydratedDocument<IActivityDoc>;

const activitySchema = new Schema<IActivityDoc>(
  {
    organizationId: { type: String, required: true, index: true },

    type: { type: String, required: true, trim: true },
    status: { type: String, required: true, default: 'planned' },

    subjectKind: { type: String, required: true },
    subjectId: { type: String, required: true },

    subject: { type: String, trim: true },
    body: { type: String, trim: true },

    scheduledAt: Date,
    completedAt: Date,
    cancelledAt: Date,

    ownerId: { type: String, trim: true },
    participantIds: { type: [String], default: [] },

    externalRef: { type: String, trim: true },

    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

// Timeline: "all activities against subject X (Contact/Account/Lead/Opportunity)".
activitySchema.index({ organizationId: 1, subjectKind: 1, subjectId: 1, scheduledAt: -1 });
// Worklist: "my planned activities ordered by scheduledAt".
activitySchema.index({ organizationId: 1, ownerId: 1, status: 1, scheduledAt: 1 });

const CrmActivity =
  mongoose.models.CrmActivity || mongoose.model<IActivityDoc>('CrmActivity', activitySchema, CRM_COLLECTIONS.Activity);

export default CrmActivity;
