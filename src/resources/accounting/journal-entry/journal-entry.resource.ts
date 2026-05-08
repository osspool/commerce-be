/**
 * Journal Entry Resource — CRUD + Stripe Actions
 *
 * State transitions (post / reverse / duplicate / archive) via declarative
 * `actions` block (POST /:id/action).
 *
 * Top-level defineResource — auto-discovered by loadResources().
 * Branch-tagged via orgScoped (organizationId from extraFields).
 */

import { defineResource } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { requireOrgMembership, requireRoles } from '@classytic/arc/permissions';
import { getOrgId } from '@classytic/arc/scope';
import type { RequestWithExtras } from '@classytic/arc/types';
import { buildCrudSchemasFromModel, QueryParser } from '@classytic/mongokit';
import { orgScoped } from '#shared/presets/index.js';
import { Journal, JournalEntry, journalEntryRepository } from '../accounting.engine.js';
import { journalEntryActions } from './journal-entry.actions.js';

const queryParser = new QueryParser({ maxLimit: 100 });

const journalEntryResource = defineResource({
  name: 'journal-entry',
  audit: true,
  displayName: 'Journal Entries',
  tag: 'Accounting',
  prefix: '/accounting/journal-entries',

  actions: journalEntryActions,

  // `softRequiredFields` (mongokit 3.5.4+) keeps `journalType` and `date` in
  // the generated body schema's `properties` (still validated when present)
  // but excludes them from `required[]` so the FE can save partial drafts.
  // The DB-level `required: true` on the ledger's Mongoose model is
  // unchanged — Mongoose still rejects null on save, and the double-entry
  // / fiscal-lock invariants fire at post() time via the ledger plugin
  // pipeline. This is the "draft now, validate at post" pattern Odoo uses.
  adapter: createMongooseAdapter({
    model: JournalEntry,
    repository: journalEntryRepository,
    schemaGenerator: (m, arcOptions) =>
      // Soft-require fields the ledger marks `required: true` but that the FE
      // shouldn't have to send when saving a draft:
      //   - journalType, date: filled in later as the user completes the form
      //   - totalDebit/totalCredit: computed by the ledger at post() time
      //   - state: defaults to 'draft' on the server
      // The DB-level required flags stay; only HTTP body validation is relaxed.
      // Double-entry balance + fiscal/day-close locks fire at post() via the
      // ledger plugin pipeline.
      buildCrudSchemasFromModel(m, {
        ...(arcOptions as Record<string, unknown>),
        softRequiredFields: ['journalType', 'date', 'totalDebit', 'totalCredit', 'state'],
      } as Parameters<typeof buildCrudSchemasFromModel>[1]),
  }),
  queryParser,
  presets: [orgScoped], // branch-tagged — orgScoped handles filtering + body schema

  schemaOptions: {
    // `journalItems` is excluded from the auto-generated body schema because
    // mongokit's converter sees the ledger's nested subdocument array as a
    // string-array (it can't introspect ledger-shipped schemas). The FE
    // sends items via a follow-up PATCH after creating the draft shell.
    excludeFields: ['journalItems', 'referenceNumber'],
    fieldRules: {
      organizationId: { systemManaged: true }, // injected by orgScoped, not in body
    },
  },

  permissions: {
    // Branch-scoped via orgScoped — reads must come from a request bound to
    // a branch (member/service/elevated). Plain authenticated shoppers (no
    // x-organization-id) get a clear "Organization membership required".
    list: requireOrgMembership(),
    get: requireOrgMembership(),
    create: requireRoles('admin', 'finance_admin', 'staff'),
    update: requireRoles('admin', 'finance_admin', 'staff'),
    delete: requireRoles('admin'),
  },

  routes: [
    {
      method: 'GET',
      path: '/by-source',
      summary: 'List journal entries that reference a given source document',
      description:
        'Audit lookup. Returns every JE that references the given source document — at the entry level (`sourceRef.{sourceModel,sourceId}`) AND/OR at any line level (line `sourceRef` PRIMARY + `linkedRefs[]` SECONDARY). Use `level=entry` to restrict to entry-level only (legacy behavior), `level=item` to restrict to line-level only (covers both line `sourceRef` and `linkedRefs[]`), or omit / pass `both` to union them (default — matches Odoo + ERPNext audit semantics). Sorted oldest first so the audit trail reads chronologically. Backed by sparse indexes on `(sourceRef.sourceModel, sourceRef.sourceId)`, `(journalItems.sourceRef.*)`, and `(journalItems.linkedRefs.*)` — opt-in via @classytic/ledger `LINE_SOURCE_INDEXES`.',
      permissions: requireOrgMembership(),
      raw: true,
      schema: {
        querystring: {
          type: 'object',
          required: ['sourceModel', 'sourceId'],
          properties: {
            sourceModel: { type: 'string', minLength: 1, maxLength: 64 },
            sourceId: { type: 'string', minLength: 1, maxLength: 128 },
            level: { type: 'string', enum: ['entry', 'item', 'both'], default: 'both' },
          },
          additionalProperties: false,
        },
      },
      handler: async (req: RequestWithExtras, reply: { send: (x: unknown) => unknown }) => {
        const orgId = getOrgId(req.scope);
        const {
          sourceModel,
          sourceId,
          level = 'both',
        } = (req.query ?? {}) as { sourceModel: string; sourceId: string; level?: 'entry' | 'item' | 'both' };
        // Build the source-ref predicate. Default `both` unions entry-level and
        // line-level (Odoo/ERPNext semantics — auditors see every JE touching
        // the source doc whether driven by it or just settling against it).
        // Line-level covers BOTH the primary `sourceRef` and the `linkedRefs[]`
        // array — a payment line that settles invoice X but also lists its
        // revenue Transaction in linkedRefs is findable via either query.
        const entryPredicate = {
          'sourceRef.sourceModel': sourceModel,
          'sourceRef.sourceId': sourceId,
        };
        const itemPredicates = [
          {
            'journalItems.sourceRef.sourceModel': sourceModel,
            'journalItems.sourceRef.sourceId': sourceId,
          },
          {
            'journalItems.linkedRefs.sourceModel': sourceModel,
            'journalItems.linkedRefs.sourceId': sourceId,
          },
        ];
        let filter: Record<string, unknown>;
        if (level === 'entry') filter = entryPredicate;
        else if (level === 'item') filter = { $or: itemPredicates };
        else filter = { $or: [entryPredicate, ...itemPredicates] };
        if (orgId) filter.organizationId = orgId;
        const docs = await JournalEntry.find(filter).sort({ date: 1, createdAt: 1 }).lean();
        return reply.send(docs);
      },
    },
    {
      method: 'GET',
      path: '/by-journal-kind',
      summary: 'List journal entries grouped by Journal.kind',
      description:
        'Convenience filter: "show me every JE under all Bank journals" or "all Sales journals". Resolves Journal docs by `kind` (sale/purchase/bank/cash/general/misc) — optionally narrowed by `code` — then queries JEs by `journal IN (...)`. For granular per-journal listing use the standard `?journal=<id>` filter on the list endpoint.',
      permissions: requireOrgMembership(),
      raw: true,
      schema: {
        querystring: {
          type: 'object',
          required: ['kind'],
          properties: {
            kind: { type: 'string', enum: ['general', 'sale', 'purchase', 'bank', 'cash', 'misc'] },
            code: { type: 'string', minLength: 1, maxLength: 64 },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
          },
          additionalProperties: false,
        },
      },
      handler: async (req: RequestWithExtras, reply: { send: (x: unknown) => unknown }) => {
        const orgId = getOrgId(req.scope);
        const { kind, code, limit = 100 } = (req.query ?? {}) as { kind: string; code?: string; limit?: number };
        const journalQuery: Record<string, unknown> = { kind };
        if (code) journalQuery.code = code;
        if (orgId) journalQuery.organizationId = orgId;
        const journals = (await Journal.find(journalQuery).lean()) as Array<{ _id: unknown }>;
        const journalIds = journals.map((j) => j._id);
        if (journalIds.length === 0) return reply.send([]);
        const filter: Record<string, unknown> = { journal: { $in: journalIds } };
        if (orgId) filter.organizationId = orgId;
        const docs = await JournalEntry.find(filter).sort({ date: -1, createdAt: -1 }).limit(limit).lean();
        return reply.send(docs);
      },
    },
  ],
});

export default journalEntryResource;
