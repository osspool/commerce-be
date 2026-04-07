import mongoose, { Schema, type HydratedDocument } from 'mongoose';

export interface IIdempotencyRecord {
  key: string;
  hash: string;
  status: 'pending' | 'completed' | 'failed';
  expiresAt: Date;
  result: unknown;
  error: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export type IdempotencyRecordDocument = HydratedDocument<IIdempotencyRecord>;

const idempotencyRecordSchema = new Schema<IIdempotencyRecord>(
  {
    key: { type: String, required: true, unique: true, index: true },
    hash: { type: String, required: true },
    status: { type: String, enum: ['pending', 'completed', 'failed'], required: true, index: true },

    expiresAt: { type: Date, required: true },

    result: { type: Schema.Types.Mixed, default: null },
    error: { type: String, default: null },
  },
  { timestamps: true },
);

// TTL cleanup for idempotency keys (MongoDB TTL monitor interval ~60s)
idempotencyRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const IdempotencyRecord =
  mongoose.models.IdempotencyRecord || mongoose.model<IIdempotencyRecord>('IdempotencyRecord', idempotencyRecordSchema);

export default IdempotencyRecord;
