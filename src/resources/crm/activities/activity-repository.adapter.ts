import type { ActivityStatus } from '@classytic/crm';
import type { Activity, ActivityFilter, ActivityRepository } from '../ports.js';
import type { CrmRequestContext } from '../context-helpers.js';
import type { IActivityDoc } from './activity.model.js';
import crmActivityRepository from './activity.repository.js';

function toActivity(doc: IActivityDoc): Activity {
  return {
    id: (doc._id as unknown as { toString(): string }).toString(),
    type: doc.type,
    status: doc.status,
    subjectKind: doc.subjectKind,
    subjectId: doc.subjectId,
    ...(doc.subject ? { subject: doc.subject } : {}),
    ...(doc.body ? { body: doc.body } : {}),
    ...(doc.scheduledAt ? { scheduledAt: doc.scheduledAt } : {}),
    ...(doc.completedAt ? { completedAt: doc.completedAt } : {}),
    ...(doc.cancelledAt ? { cancelledAt: doc.cancelledAt } : {}),
    ...(doc.ownerId ? { ownerId: doc.ownerId } : {}),
    ...(doc.participantIds.length ? { participantIds: doc.participantIds } : {}),
    ...(doc.externalRef ? { externalRef: doc.externalRef } : {}),
    ...(doc.metadata ? { metadata: doc.metadata } : {}),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

type ModelLike = {
  findOne: (q: object) => Promise<IActivityDoc | null>;
  find: (q: object, p?: object, o?: object) => Promise<IActivityDoc[]>;
  findOneAndUpdate: (q: object, p: object, o: object) => Promise<IActivityDoc | null>;
};

export function createActivityRepositoryAdapter(ctx: CrmRequestContext): ActivityRepository {
  const Model = (crmActivityRepository as unknown as { Model: ModelLike }).Model;
  const scope = { organizationId: ctx.organizationId };

  return {
    async findById(id) {
      const doc = await Model.findOne({ _id: id, ...scope });
      return doc ? toActivity(doc) : null;
    },

    async list(filter: ActivityFilter = {}) {
      const query: Record<string, unknown> = { ...scope };
      if (filter.subjectKind) query.subjectKind = filter.subjectKind;
      if (filter.subjectId) query.subjectId = filter.subjectId;
      if (filter.status) {
        query.status = Array.isArray(filter.status) ? { $in: filter.status } : filter.status;
      }
      if (filter.ownerId) query.ownerId = filter.ownerId;
      if (filter.scheduledBetween) {
        query.scheduledAt = {
          $gte: filter.scheduledBetween.from,
          $lte: filter.scheduledBetween.to,
        };
      }
      const docs = await Model.find(query);
      return docs.map(toActivity);
    },

    async create(input) {
      const created = await crmActivityRepository.create({
        ...scope,
        ...input,
        participantIds: input.participantIds ? [...input.participantIds] : [],
      } as unknown as Partial<IActivityDoc>);
      return toActivity(created as unknown as IActivityDoc);
    },

    async update(id, patch) {
      const { participantIds, ...rest } = patch;
      const mongoPatch: Record<string, unknown> = { ...rest };
      if (participantIds) mongoPatch.participantIds = [...participantIds];

      const updated = await Model.findOneAndUpdate(
        { _id: id, ...scope },
        { $set: mongoPatch },
        { returnDocument: 'after' },
      );
      if (!updated) throw new Error(`Activity '${id}' not found in scope`);
      return toActivity(updated);
    },

    async casStatus(id, expected: ActivityStatus, next: ActivityStatus, patch) {
      const { participantIds, ...rest } = patch ?? {};
      const mongoPatch: Record<string, unknown> = { ...rest, status: next };
      if (participantIds) mongoPatch.participantIds = [...participantIds];

      const updated = await Model.findOneAndUpdate(
        { _id: id, status: expected, ...scope },
        { $set: mongoPatch },
        { returnDocument: 'after' },
      );
      return updated ? toActivity(updated) : null;
    },
  };
}
