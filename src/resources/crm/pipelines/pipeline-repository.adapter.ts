import type { Pipeline, PipelineRepository, Stage } from '@classytic/crm';
import type { CrmRequestContext } from '../context-helpers.js';
import type { IPipelineDoc, IStage } from './pipeline.model.js';
import crmPipelineRepository from './pipeline.repository.js';

function toStage(s: IStage): Stage {
  return {
    id: s.id,
    name: s.name,
    sequence: s.sequence,
    defaultProbability: s.defaultProbability,
    ...(s.color ? { color: s.color } : {}),
    ...(s.description ? { description: s.description } : {}),
  };
}

function toPipeline(doc: IPipelineDoc): Pipeline {
  return {
    id: (doc._id as unknown as { toString(): string }).toString(),
    name: doc.name,
    isArchived: doc.isArchived,
    stages: doc.stages.map(toStage),
    ...(doc.teamRef ? { teamRef: doc.teamRef } : {}),
    ...(doc.metadata ? { metadata: doc.metadata } : {}),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

type ModelLike = {
  findOne: (q: object) => Promise<IPipelineDoc | null>;
  find: (q: object) => Promise<IPipelineDoc[]>;
  findOneAndUpdate: (q: object, p: object, o: object) => Promise<IPipelineDoc | null>;
};

export function createPipelineRepositoryAdapter(ctx: CrmRequestContext): PipelineRepository {
  const Model = (crmPipelineRepository as unknown as { Model: ModelLike }).Model;
  const scope = { organizationId: ctx.organizationId };

  return {
    async findById(id) {
      const doc = await Model.findOne({ _id: id, ...scope });
      return doc ? toPipeline(doc) : null;
    },

    async list(includeArchived = false) {
      const query: Record<string, unknown> = { ...scope };
      if (!includeArchived) query.isArchived = false;
      const docs = await Model.find(query);
      return docs.map(toPipeline);
    },

    async create(input) {
      const created = await crmPipelineRepository.create({
        ...scope,
        name: input.name,
        isArchived: input.isArchived,
        stages: input.stages.map(toStage),
        ...(input.teamRef ? { teamRef: input.teamRef } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      } as unknown as Partial<IPipelineDoc>);
      return toPipeline(created as unknown as IPipelineDoc);
    },

    async update(id, patch) {
      const mongoPatch: Record<string, unknown> = {};
      if (patch.name !== undefined) mongoPatch.name = patch.name;
      if (patch.isArchived !== undefined) mongoPatch.isArchived = patch.isArchived;
      if (patch.stages !== undefined) mongoPatch.stages = patch.stages.map(toStage);
      if (patch.teamRef !== undefined) mongoPatch.teamRef = patch.teamRef;
      if (patch.metadata !== undefined) mongoPatch.metadata = patch.metadata;

      const updated = await Model.findOneAndUpdate(
        { _id: id, ...scope },
        { $set: mongoPatch },
        { returnDocument: 'after' },
      );
      if (!updated) throw new Error(`Pipeline '${id}' not found in scope`);
      return toPipeline(updated);
    },
  };
}
