/**
 * ApprovalPolicy — admin-curated matrix row.
 *
 * One policy = "for subject `X`, when conditions match, attach this chain
 * template". At submit time, the resolver scans active policies for the
 * subject, picks the highest-`priority` one whose conditions all match the
 * subject's evaluation context, and converts the template into a concrete
 * `ApprovalChain` (resolving role → user IDs along the way).
 *
 * Why a Mongo collection rather than code-defined constants:
 *   - Finance/admins tweak thresholds without a deploy
 *   - Audit log of who changed what threshold when
 *   - Versioned: bumping `version` on edit lets us snapshot
 *     `approvalPolicyVersion` onto the subject doc (so a chain captures
 *     which policy revision generated it, surviving later policy edits)
 */

import mongoose, { type HydratedDocument, Schema } from 'mongoose';

export interface IPolicyCondition {
  field: string;
  op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne' | 'in' | 'nin';
  value: number | string | boolean | Array<number | string>;
}

export interface IChainStepTemplate {
  id: string;
  name?: string;
  /** Literal user IDs — wins over `roles` when both are set. */
  userIds?: string[];
  /** Org roles to expand into approver IDs at submit time. */
  roles?: string[];
  /** Quorum within step (default 1). */
  requiredApprovals?: number;
}

export interface IChainTemplate {
  order: 'sequential' | 'parallel';
  steps: IChainStepTemplate[];
}

export interface IApprovalPolicy {
  /** Optional human-friendly identifier — defaults to first matching subject. */
  name: string;
  description?: string;

  /** Matches `withApprovalChain({ subjectType })`. */
  subjectType: string;

  /**
   * Optional branch scope. When set, only matches subjects whose evaluation
   * context `branchId` equals this value. When unset, applies to all branches.
   */
  branchId?: string | null;

  /** AND'd conditions on the subject's `EvaluationContext`. */
  conditions: IPolicyCondition[];

  chainTemplate: IChainTemplate;

  /** Higher = preferred when multiple policies match. */
  priority: number;

  /** Inactive policies are skipped by the resolver. */
  active: boolean;

  /** Bumped on every save — snapshot onto subject docs for traceability. */
  version: number;

  createdBy?: string | null;
  modifiedBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ApprovalPolicyDocument = HydratedDocument<IApprovalPolicy>;

const conditionSchema = new Schema<IPolicyCondition>(
  {
    field: { type: String, required: true, trim: true },
    op: {
      type: String,
      required: true,
      enum: ['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'in', 'nin'],
    },
    value: { type: Schema.Types.Mixed, required: true },
  },
  { _id: false },
);

const chainStepTemplateSchema = new Schema<IChainStepTemplate>(
  {
    id: { type: String, required: true, trim: true },
    name: { type: String, trim: true },
    userIds: { type: [String], default: undefined },
    roles: { type: [String], default: undefined },
    requiredApprovals: { type: Number, min: 1, default: 1 },
  },
  { _id: false },
);

const chainTemplateSchema = new Schema<IChainTemplate>(
  {
    order: { type: String, enum: ['sequential', 'parallel'], required: true, default: 'sequential' },
    steps: { type: [chainStepTemplateSchema], required: true, default: [] },
  },
  { _id: false },
);

const policySchema = new Schema<IApprovalPolicy>(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    subjectType: { type: String, required: true, trim: true, index: true },
    branchId: { type: String, default: null, index: true },
    conditions: { type: [conditionSchema], default: [] },
    chainTemplate: { type: chainTemplateSchema, required: true },
    priority: { type: Number, default: 0, index: true },
    active: { type: Boolean, default: true, index: true },
    version: { type: Number, default: 1 },
    createdBy: { type: String, default: null },
    modifiedBy: { type: String, default: null },
  },
  { timestamps: true },
);

// Resolver hot path: list active policies for a subject in a branch.
policySchema.index({ subjectType: 1, active: 1, priority: -1 });

// Auto-bump `version` on every update so subject docs that snapshot
// `approvalPolicyVersion` at submit time can later detect "the policy was
// edited after I submitted". Uses the query middleware (not `pre('save')`)
// because Arc's adapter goes through `findOneAndUpdate` / `updateOne`.
//
// Skip when the update already contains `$inc.version` (e.g. callers who
// bumped explicitly) or `$set.version` (admin-led version override) — the
// caller's intent wins.
policySchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function bumpVersion() {
  const update = this.getUpdate() as Record<string, unknown> | null;
  if (!update) return;
  const $inc = (update.$inc ?? {}) as Record<string, unknown>;
  const $set = (update.$set ?? {}) as Record<string, unknown>;
  if ('version' in $inc || 'version' in $set || 'version' in update) return;
  $inc.version = 1;
  update.$inc = $inc;
  this.setUpdate(update);
});

const ApprovalPolicy =
  (mongoose.models.ApprovalPolicy as mongoose.Model<IApprovalPolicy>) ||
  mongoose.model<IApprovalPolicy>('ApprovalPolicy', policySchema);

export default ApprovalPolicy;
