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
import { requireOrgMembership, requireRoles } from '@classytic/arc/permissions';
import { QueryParser } from '@classytic/mongokit';
import { createAdapter } from '#shared/adapter.js';
import { orgScoped } from '#shared/presets/index.js';
import { JournalEntry, journalEntryRepository } from '../accounting.engine.js';
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
  adapter: createAdapter(JournalEntry, journalEntryRepository, {
    // Soft-require fields the ledger marks `required: true` but that the FE
    // shouldn't have to send when saving a draft:
    //   - journalType, date: filled in later as the user completes the form
    //   - totalDebit/totalCredit: computed by the ledger at post() time
    //   - state: defaults to 'draft' on the server
    // The DB-level required flags stay; only HTTP body validation is relaxed.
    // Double-entry balance + fiscal/day-close locks fire at post() via the
    // ledger plugin pipeline.
    softRequiredFields: ['journalType', 'date', 'totalDebit', 'totalCredit', 'state'],
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
});

export default journalEntryResource;
