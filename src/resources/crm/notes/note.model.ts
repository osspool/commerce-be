import type { SubjectKind } from '@classytic/crm';
import mongoose, { type HydratedDocument, Schema, type Types } from 'mongoose';
import { CRM_COLLECTIONS } from '../collections.js';

export interface INoteDoc {
  _id: Types.ObjectId;
  organizationId: string;

  subjectKind: SubjectKind;
  subjectId: string;

  body: string;
  authorId?: string;
  format: 'plain' | 'markdown';

  metadata?: Record<string, unknown>;

  createdAt: Date;
  updatedAt: Date;
}

export type NoteDocument = HydratedDocument<INoteDoc>;

const noteSchema = new Schema<INoteDoc>(
  {
    organizationId: { type: String, required: true, index: true },

    subjectKind: { type: String, required: true },
    subjectId: { type: String, required: true },

    body: { type: String, required: true },
    authorId: { type: String, trim: true },
    format: { type: String, enum: ['plain', 'markdown'], default: 'plain' },

    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

// Timeline of notes for a subject, most-recent first.
noteSchema.index({ organizationId: 1, subjectKind: 1, subjectId: 1, createdAt: -1 });

const CrmNote = mongoose.models.CrmNote || mongoose.model<INoteDoc>('CrmNote', noteSchema, CRM_COLLECTIONS.Note);

export default CrmNote;
