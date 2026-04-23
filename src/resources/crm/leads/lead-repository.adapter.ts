import type { Lead, LeadFilter, LeadRepository, LeadStatus, LeadStatusEntry } from '@classytic/crm';
import type { CrmRequestContext } from '../context-helpers.js';
import type { ILeadDoc, ILeadStatusEntry } from './lead.model.js';
import crmLeadRepository from './lead.repository.js';

function toStatusEntry(e: ILeadStatusEntry): LeadStatusEntry {
  return {
    status: e.status,
    occurredAt: e.occurredAt,
    ...(e.by ? { by: e.by } : {}),
    ...(e.note ? { note: e.note } : {}),
  };
}

function toLead(doc: ILeadDoc): Lead {
  return {
    id: (doc._id as unknown as { toString(): string }).toString(),
    ...(doc.firstName ? { firstName: doc.firstName } : {}),
    ...(doc.lastName ? { lastName: doc.lastName } : {}),
    fullName: doc.fullName,
    ...(doc.email ? { email: doc.email } : {}),
    ...(doc.phone ? { phone: doc.phone } : {}),
    ...(doc.companyName ? { companyName: doc.companyName } : {}),
    ...(doc.jobTitle ? { jobTitle: doc.jobTitle } : {}),
    ...(doc.source ? { source: doc.source } : {}),
    ...(doc.campaignRef ? { campaignRef: doc.campaignRef } : {}),
    ...(doc.score !== undefined ? { score: doc.score } : {}),
    status: doc.status,
    statusHistory: doc.statusHistory.map(toStatusEntry),
    ...(doc.ownerId ? { ownerId: doc.ownerId } : {}),
    ...(doc.tags && doc.tags.length ? { tags: doc.tags } : {}),
    ...(doc.convertedContactId ? { convertedContactId: doc.convertedContactId } : {}),
    ...(doc.convertedAccountId ? { convertedAccountId: doc.convertedAccountId } : {}),
    ...(doc.convertedOpportunityId ? { convertedOpportunityId: doc.convertedOpportunityId } : {}),
    ...(doc.convertedAt ? { convertedAt: doc.convertedAt } : {}),
    ...(doc.disqualifyReason ? { disqualifyReason: doc.disqualifyReason } : {}),
    ...(doc.metadata ? { metadata: doc.metadata } : {}),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

type ModelLike = {
  findOne: (q: object) => Promise<ILeadDoc | null>;
  find: (q: object) => Promise<ILeadDoc[]>;
  findOneAndUpdate: (q: object, p: object, o: object) => Promise<ILeadDoc | null>;
};

export function createLeadRepositoryAdapter(ctx: CrmRequestContext): LeadRepository {
  const Model = (crmLeadRepository as unknown as { Model: ModelLike }).Model;
  const scope = { organizationId: ctx.organizationId };

  return {
    async findById(id) {
      const doc = await Model.findOne({ _id: id, ...scope });
      return doc ? toLead(doc) : null;
    },

    async findByEmail(email) {
      const doc = await Model.findOne({ email: email.toLowerCase().trim(), ...scope });
      return doc ? toLead(doc) : null;
    },

    async list(filter: LeadFilter = {}) {
      const query: Record<string, unknown> = { ...scope };
      if (filter.status) {
        query.status = Array.isArray(filter.status) ? { $in: filter.status } : filter.status;
      }
      if (filter.ownerId) query.ownerId = filter.ownerId;
      if (filter.source) query.source = filter.source;
      if (filter.minScore !== undefined) query.score = { $gte: filter.minScore };
      const docs = await Model.find(query);
      return docs.map(toLead);
    },

    async create(input) {
      const created = await crmLeadRepository.create({
        ...scope,
        ...input,
        tags: input.tags ? [...input.tags] : [],
        statusHistory: [...input.statusHistory],
      } as unknown as Partial<ILeadDoc>);
      return toLead(created as unknown as ILeadDoc);
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
      if (!updated) throw new Error(`Lead '${id}' not found in scope`);
      return toLead(updated);
    },

    /**
     * Atomic status transition — find-modify-return guarded on expected
     * status so concurrent writers can't race past each other. Returns
     * null when the precondition fails (status drifted), matching the
     * CRM service's expectation.
     */
    async casStatus(id, expected: LeadStatus, next: LeadStatus, patch) {
      const { statusHistory, tags, ...rest } = patch ?? {};
      const mongoPatch: Record<string, unknown> = { ...rest, status: next };
      if (tags) mongoPatch.tags = [...tags];
      if (statusHistory) mongoPatch.statusHistory = [...statusHistory];

      const updated = await Model.findOneAndUpdate(
        { _id: id, status: expected, ...scope },
        { $set: mongoPatch },
        { returnDocument: 'after' },
      );
      return updated ? toLead(updated) : null;
    },
  };
}
