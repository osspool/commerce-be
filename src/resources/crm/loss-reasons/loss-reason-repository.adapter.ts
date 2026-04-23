import type { LossReason, LossReasonRepository } from '@classytic/crm';
import type { CrmRequestContext } from '../context-helpers.js';
import type { ILossReasonDoc } from './loss-reason.model.js';
import crmLossReasonRepository from './loss-reason.repository.js';

function toLossReason(doc: ILossReasonDoc): LossReason {
  return {
    id: (doc._id as unknown as { toString(): string }).toString(),
    name: doc.name,
    active: doc.active,
    ...(doc.category ? { category: doc.category } : {}),
    ...(doc.description ? { description: doc.description } : {}),
    ...(doc.metadata ? { metadata: doc.metadata } : {}),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

type ModelLike = {
  findOne: (q: object) => Promise<ILossReasonDoc | null>;
  find: (q: object) => Promise<ILossReasonDoc[]>;
  findOneAndUpdate: (q: object, p: object, o: object) => Promise<ILossReasonDoc | null>;
};

export function createLossReasonRepositoryAdapter(ctx: CrmRequestContext): LossReasonRepository {
  const Model = (crmLossReasonRepository as unknown as { Model: ModelLike }).Model;
  const scope = { organizationId: ctx.organizationId };

  return {
    async findById(id) {
      const doc = await Model.findOne({ _id: id, ...scope });
      return doc ? toLossReason(doc) : null;
    },

    async list(activeOnly = false) {
      const query: Record<string, unknown> = { ...scope };
      if (activeOnly) query.active = true;
      const docs = await Model.find(query);
      return docs.map(toLossReason);
    },

    async create(input) {
      const created = await crmLossReasonRepository.create({
        ...scope,
        name: input.name,
        active: input.active,
        ...(input.category ? { category: input.category } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      } as unknown as Partial<ILossReasonDoc>);
      return toLossReason(created as unknown as ILossReasonDoc);
    },

    async update(id, patch) {
      const mongoPatch: Record<string, unknown> = {};
      if (patch.name !== undefined) mongoPatch.name = patch.name;
      if (patch.category !== undefined) mongoPatch.category = patch.category;
      if (patch.description !== undefined) mongoPatch.description = patch.description;
      if (patch.active !== undefined) mongoPatch.active = patch.active;
      if (patch.metadata !== undefined) mongoPatch.metadata = patch.metadata;

      const updated = await Model.findOneAndUpdate(
        { _id: id, ...scope },
        { $set: mongoPatch },
        { returnDocument: 'after' },
      );
      if (!updated) throw new Error(`LossReason '${id}' not found in scope`);
      return toLossReason(updated);
    },
  };
}
