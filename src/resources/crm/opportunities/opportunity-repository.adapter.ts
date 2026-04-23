import type {
  Opportunity,
  OpportunityFilter,
  OpportunityRepository,
  OpportunityStatus,
  OpportunityStatusEntry,
} from '@classytic/crm';
import type { CrmRequestContext } from '../context-helpers.js';
import type { IOpportunityDoc, IOpportunityStatusEntry } from './opportunity.model.js';
import crmOpportunityRepository from './opportunity.repository.js';

function toStatusEntry(e: IOpportunityStatusEntry): OpportunityStatusEntry {
  return {
    status: e.status,
    occurredAt: e.occurredAt,
    ...(e.stageId ? { stageId: e.stageId } : {}),
    ...(e.by ? { by: e.by } : {}),
    ...(e.note ? { note: e.note } : {}),
  };
}

function toOpportunity(doc: IOpportunityDoc): Opportunity {
  return {
    id: (doc._id as unknown as { toString(): string }).toString(),
    name: doc.name,
    ...(doc.accountId ? { accountId: doc.accountId } : {}),
    ...(doc.primaryContactId ? { primaryContactId: doc.primaryContactId } : {}),
    pipelineId: doc.pipelineId,
    stageId: doc.stageId,
    status: doc.status,
    statusHistory: doc.statusHistory.map(toStatusEntry),
    ...(doc.amount ? { amount: doc.amount } : {}),
    probability: doc.probability,
    ...(doc.expectedCloseAt ? { expectedCloseAt: doc.expectedCloseAt } : {}),
    ...(doc.closedAt ? { closedAt: doc.closedAt } : {}),
    ...(doc.lostReasonId ? { lostReasonId: doc.lostReasonId } : {}),
    ...(doc.ownerId ? { ownerId: doc.ownerId } : {}),
    ...(doc.sourceLeadId ? { sourceLeadId: doc.sourceLeadId } : {}),
    ...(doc.tags && doc.tags.length ? { tags: doc.tags } : {}),
    ...(doc.metadata ? { metadata: doc.metadata } : {}),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

type ModelLike = {
  findOne: (q: object) => Promise<IOpportunityDoc | null>;
  find: (q: object) => Promise<IOpportunityDoc[]>;
  findOneAndUpdate: (q: object, p: object, o: object) => Promise<IOpportunityDoc | null>;
  deleteOne: (q: object) => Promise<unknown>;
};

export function createOpportunityRepositoryAdapter(ctx: CrmRequestContext): OpportunityRepository {
  const Model = (crmOpportunityRepository as unknown as { Model: ModelLike }).Model;
  const scope = { organizationId: ctx.organizationId };

  return {
    async findById(id) {
      const doc = await Model.findOne({ _id: id, ...scope });
      return doc ? toOpportunity(doc) : null;
    },

    async list(filter: OpportunityFilter = {}) {
      const query: Record<string, unknown> = { ...scope };
      if (filter.status) {
        query.status = Array.isArray(filter.status) ? { $in: filter.status } : filter.status;
      }
      if (filter.pipelineId) query.pipelineId = filter.pipelineId;
      if (filter.stageId) query.stageId = filter.stageId;
      if (filter.ownerId) query.ownerId = filter.ownerId;
      if (filter.accountId) query.accountId = filter.accountId;
      if (filter.closingBetween) {
        query.expectedCloseAt = {
          $gte: filter.closingBetween.from,
          $lte: filter.closingBetween.to,
        };
      }
      const docs = await Model.find(query);
      return docs.map(toOpportunity);
    },

    async create(input) {
      const created = await crmOpportunityRepository.create({
        ...scope,
        ...input,
        tags: input.tags ? [...input.tags] : [],
        statusHistory: [...input.statusHistory],
      } as unknown as Partial<IOpportunityDoc>);
      return toOpportunity(created as unknown as IOpportunityDoc);
    },

    async update(id, patch) {
      const { statusHistory, tags, ...rest } = patch;
      const mongoPatch: Record<string, unknown> = { ...rest };
      if (tags) mongoPatch.tags = [...tags];
      if (statusHistory) mongoPatch.statusHistory = [...statusHistory];

      const updated = await Model.findOneAndUpdate(
        { _id: id, ...scope },
        { $set: mongoPatch },
        { returnDocument: 'after' },
      );
      if (!updated) throw new Error(`Opportunity '${id}' not found in scope`);
      return toOpportunity(updated);
    },

    async delete(id) {
      await Model.deleteOne({ _id: id, ...scope });
    },

    /** Atomic terminal-status transition guarded on current status. */
    async casStatus(id, expected: OpportunityStatus, next: OpportunityStatus, patch) {
      const { statusHistory, tags, ...rest } = patch ?? {};
      const mongoPatch: Record<string, unknown> = { ...rest, status: next };
      if (tags) mongoPatch.tags = [...tags];
      if (statusHistory) mongoPatch.statusHistory = [...statusHistory];

      const updated = await Model.findOneAndUpdate(
        { _id: id, status: expected, ...scope },
        { $set: mongoPatch },
        { returnDocument: 'after' },
      );
      return updated ? toOpportunity(updated) : null;
    },

    /** Atomic stage transition — same shape as `casStatus` but guards on `stageId`. */
    async casStage(id, expectedStageId: string, nextStageId: string, patch) {
      const { statusHistory, tags, ...rest } = patch ?? {};
      const mongoPatch: Record<string, unknown> = { ...rest, stageId: nextStageId };
      if (tags) mongoPatch.tags = [...tags];
      if (statusHistory) mongoPatch.statusHistory = [...statusHistory];

      const updated = await Model.findOneAndUpdate(
        { _id: id, stageId: expectedStageId, ...scope },
        { $set: mongoPatch },
        { returnDocument: 'after' },
      );
      return updated ? toOpportunity(updated) : null;
    },
  };
}
