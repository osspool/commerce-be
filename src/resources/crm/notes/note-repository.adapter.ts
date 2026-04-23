import type { Note, NoteRepository, SubjectKind } from '@classytic/crm';
import type { CrmRequestContext } from '../context-helpers.js';
import type { INoteDoc } from './note.model.js';
import crmNoteRepository from './note.repository.js';

function toNote(doc: INoteDoc): Note {
  return {
    id: (doc._id as unknown as { toString(): string }).toString(),
    subjectKind: doc.subjectKind,
    subjectId: doc.subjectId,
    body: doc.body,
    format: doc.format,
    ...(doc.authorId ? { authorId: doc.authorId } : {}),
    ...(doc.metadata ? { metadata: doc.metadata } : {}),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

type ModelLike = {
  findOne: (q: object) => Promise<INoteDoc | null>;
  find: (q: object, p?: object, o?: object) => Promise<INoteDoc[]>;
  findOneAndUpdate: (q: object, p: object, o: object) => Promise<INoteDoc | null>;
  deleteOne: (q: object) => Promise<unknown>;
};

export function createNoteRepositoryAdapter(ctx: CrmRequestContext): NoteRepository {
  const Model = (crmNoteRepository as unknown as { Model: ModelLike }).Model;
  const scope = { organizationId: ctx.organizationId };

  return {
    async findById(id) {
      const doc = await Model.findOne({ _id: id, ...scope });
      return doc ? toNote(doc) : null;
    },

    async listBySubject(subjectKind: SubjectKind, subjectId: string) {
      const docs = await Model.find({ ...scope, subjectKind, subjectId });
      return docs.map(toNote);
    },

    async create(input) {
      const created = await crmNoteRepository.create({
        ...scope,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        body: input.body,
        format: input.format ?? 'plain',
        ...(input.authorId ? { authorId: input.authorId } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      } as unknown as Partial<INoteDoc>);
      return toNote(created as unknown as INoteDoc);
    },

    async update(id, patch) {
      const mongoPatch: Record<string, unknown> = {};
      if (patch.body !== undefined) mongoPatch.body = patch.body;
      if (patch.authorId !== undefined) mongoPatch.authorId = patch.authorId;
      if (patch.format !== undefined) mongoPatch.format = patch.format;
      if (patch.metadata !== undefined) mongoPatch.metadata = patch.metadata;

      const updated = await Model.findOneAndUpdate(
        { _id: id, ...scope },
        { $set: mongoPatch },
        { returnDocument: 'after' },
      );
      if (!updated) throw new Error(`Note '${id}' not found in scope`);
      return toNote(updated);
    },

    async delete(id) {
      await Model.deleteOne({ _id: id, ...scope });
    },
  };
}
