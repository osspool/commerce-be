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
  error: String,
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

const Job = mongoose.models.Job || mongoose.model("Job", jobSchema);
export default Job;
