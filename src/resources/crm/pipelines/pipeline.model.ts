import mongoose, { type HydratedDocument, Schema, type Types } from 'mongoose';
import { CRM_COLLECTIONS } from '../collections.js';

export interface IStage {
  id: string;
  name: string;
  sequence: number;
  defaultProbability: number;
  color?: string;
  description?: string;
}

export interface IPipelineDoc {
  _id: Types.ObjectId;
  organizationId: string;

  name: string;
  isArchived: boolean;
  stages: IStage[];
  teamRef?: string;
  metadata?: Record<string, unknown>;

  createdAt: Date;
  updatedAt: Date;
}

export type PipelineDocument = HydratedDocument<IPipelineDoc>;

const stageSchema = new Schema<IStage>(
  {
    id: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    sequence: { type: Number, required: true, min: 0 },
    defaultProbability: { type: Number, required: true, min: 0, max: 1 },
    color: { type: String, trim: true },
    description: { type: String, trim: true },
  },
  { _id: false },
);

const pipelineSchema = new Schema<IPipelineDoc>(
  {
    organizationId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    isArchived: { type: Boolean, default: false },
    stages: { type: [stageSchema], default: [] },
    teamRef: { type: String, trim: true },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

// Pipeline picker: "active pipelines for a branch".
pipelineSchema.index({ organizationId: 1, isArchived: 1 });
pipelineSchema.index({ organizationId: 1, name: 1 }, { unique: true, partialFilterExpression: { isArchived: false } });

const CrmPipeline =
  mongoose.models.CrmPipeline || mongoose.model<IPipelineDoc>('CrmPipeline', pipelineSchema, CRM_COLLECTIONS.Pipeline);

export default CrmPipeline;
