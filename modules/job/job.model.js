import mongoose from 'mongoose';
import { STATUS_VALUES, JOB_TYPE_VALUES } from '#common/constants/enums.js';

const jobSchema = new mongoose.Schema({
  type: {
      type: String,
      required: true,
      enum: JOB_TYPE_VALUES,
  },
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "organization",
},
  attempts: {
    type: Number,
    default: 0,
    min: 0,
  },
  maxRetries: {
    type: Number,
    default: 3,
    min: 0,
  },
  priority: {
    type: Number,
    default: 0,
  },
  scheduledFor: {
    type: Date,
    default: Date.now,
    index: true,
  },
  lastRun: {
    type: Date,
    default: null
  },
  status: {
      type: String,
      enum: STATUS_VALUES,
      default: 'pending'
  },
  metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
  },
  data: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
  },
  error: String,
  lastError: String,
  lastErrorAt: Date,
  startedAt: Date,
  completedAt: Date,
}, {
  timestamps: true
});

// Indexes optimized for mongokit pagination
// Compound index for multi-tenant job pagination
jobSchema.index({ organization: 1, createdAt: -1, _id: -1 });

// Compound index for filtering by type and status with pagination
jobSchema.index({ organization: 1, type: 1, status: 1, createdAt: -1, _id: -1 });

// Queue performance: find runnable jobs quickly (supports priority + schedule)
jobSchema.index({ status: 1, scheduledFor: 1, priority: -1, createdAt: 1 });

// Auto-cleanup: Expire completed/failed jobs after 7 days
// This uses MongoDB's native TTL feature (no cron required)
jobSchema.index({ completedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

const Job = mongoose.models.Job || mongoose.model("Job", jobSchema);
export default Job;
