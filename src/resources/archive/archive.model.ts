import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';

export interface IArchive {
  type: 'order' | 'transaction';
  organizationId?: Types.ObjectId;
  rangeFrom?: Date;
  rangeTo?: Date;
  filePath: string;
  format: string;
  recordCount: number;
  sizeBytes: number;
  archivedAt: Date;
  expiresAt?: Date;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type ArchiveDocument = HydratedDocument<IArchive>;

const archiveSchema = new Schema<IArchive>(
  {
    type: { type: String, enum: ['order', 'transaction'], required: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization' },
    rangeFrom: { type: Date },
    rangeTo: { type: Date },
    filePath: { type: String, required: true },
    format: { type: String, enum: ['json'], default: 'json' },
    recordCount: { type: Number, default: 0 },
    sizeBytes: { type: Number, default: 0 },
    archivedAt: { type: Date, default: () => new Date() },
    expiresAt: { type: Date },
    notes: { type: String },
  },
  { timestamps: true },
);

archiveSchema.index({ organizationId: 1, archivedAt: -1, _id: -1 });
archiveSchema.index({ organizationId: 1, type: 1, archivedAt: -1, _id: -1 });
archiveSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Archive = mongoose.models.Archive || mongoose.model('Archive', archiveSchema);
export default Archive;
