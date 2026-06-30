import type { Account, AccountFilter, AccountRepository } from '../ports.js';
import type { CrmRequestContext } from '../context-helpers.js';
import type { IAccountDoc } from './account.model.js';
import crmAccountRepository from './account.repository.js';

function toAccount(doc: IAccountDoc): Account {
  return {
    id: (doc._id as unknown as { toString(): string }).toString(),
    name: doc.name,
    ...(doc.domain ? { domain: doc.domain } : {}),
    ...(doc.industry ? { industry: doc.industry } : {}),
    ...(doc.sizeBucket ? { sizeBucket: doc.sizeBucket } : {}),
    ...(doc.annualRevenue ? { annualRevenue: doc.annualRevenue } : {}),
    ...(doc.ownerId ? { ownerId: doc.ownerId } : {}),
    ...(doc.tags && doc.tags.length ? { tags: doc.tags } : {}),
    ...(doc.metadata ? { metadata: doc.metadata } : {}),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Host-side `AccountRepository` adapter. Binds branch scope into every query
 * so CRM services stay branch-agnostic.
 */
export function createAccountRepositoryAdapter(ctx: CrmRequestContext): AccountRepository {
  const repo = crmAccountRepository;
  const scope = { organizationId: ctx.organizationId };

  return {
    async findById(id) {
      const doc = await repo.getByQuery({ _id: id, ...scope });
      return doc ? toAccount(doc as unknown as IAccountDoc) : null;
    },

    async findByDomain(domain) {
      const doc = await repo.getByQuery({ domain: domain.toLowerCase().trim(), ...scope });
      return doc ? toAccount(doc as unknown as IAccountDoc) : null;
    },

    async list(filter: AccountFilter = {}) {
      const query: Record<string, unknown> = { ...scope };
      if (filter.ownerId) query.ownerId = filter.ownerId;
      if (filter.industry) query.industry = filter.industry;
      if (filter.domain) query.domain = filter.domain.toLowerCase().trim();
      if (filter.tags && filter.tags.length) query.tags = { $all: [...filter.tags] };
      const docs = await repo.findAll(query);
      return (docs as unknown as IAccountDoc[]).map(toAccount);
    },

    async create(input) {
      const created = await repo.create({
        ...scope,
        name: input.name,
        ...(input.domain ? { domain: input.domain } : {}),
        ...(input.industry ? { industry: input.industry } : {}),
        ...(input.sizeBucket ? { sizeBucket: input.sizeBucket } : {}),
        ...(input.annualRevenue ? { annualRevenue: input.annualRevenue } : {}),
        ...(input.ownerId ? { ownerId: input.ownerId } : {}),
        tags: input.tags ? [...input.tags] : [],
        ...(input.metadata ? { metadata: input.metadata } : {}),
      } as Partial<IAccountDoc>);
      return toAccount(created as unknown as IAccountDoc);
    },

    async update(id, patch) {
      const mongoPatch: Record<string, unknown> = {};
      if (patch.name) mongoPatch.name = patch.name;
      if (patch.domain !== undefined) mongoPatch.domain = patch.domain;
      if (patch.industry !== undefined) mongoPatch.industry = patch.industry;
      if (patch.sizeBucket !== undefined) mongoPatch.sizeBucket = patch.sizeBucket;
      if (patch.annualRevenue !== undefined) mongoPatch.annualRevenue = patch.annualRevenue;
      if (patch.ownerId !== undefined) mongoPatch.ownerId = patch.ownerId;
      if (patch.tags) mongoPatch.tags = [...patch.tags];
      if (patch.metadata !== undefined) mongoPatch.metadata = patch.metadata;

      const Model = (
        repo as unknown as {
          Model: { findOneAndUpdate: (q: object, p: object, o: object) => Promise<IAccountDoc | null> };
        }
      ).Model;
      const updated = await Model.findOneAndUpdate(
        { _id: id, ...scope },
        { $set: mongoPatch },
        { returnDocument: 'after' },
      );
      if (!updated) throw new Error(`Account '${id}' not found in scope`);
      return toAccount(updated);
    },

    async delete(id) {
      const Model = (repo as unknown as { Model: { deleteOne: (q: object) => Promise<unknown> } }).Model;
      await Model.deleteOne({ _id: id, ...scope });
    },
  };
}
