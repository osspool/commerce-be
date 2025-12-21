import mongoose from 'mongoose';

const { Schema } = mongoose;

const idempotencyRecordSchema = new Schema({
  key: { type: String, required: true, unique: true, index: true },
  hash: { type: String, required: true },
  status: { type: String, enum: ['pending', 'completed', 'failed'], required: true, index: true },

  expiresAt: { type: Date, required: true, index: true },

  result: { type: Schema.Types.Mixed, default: null },
  error: { type: String, default: null },
}, { timestamps: true });

// TTL cleanup for idempotency keys (MongoDB TTL monitor interval ~60s)
idempotencyRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const IdempotencyRecord =
  mongoose.models.IdempotencyRecord || mongoose.model('IdempotencyRecord', idempotencyRecordSchema);

export default IdempotencyRecord;

