import { defineResource } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import crmPermissions from '#config/permissions/crm.js';
import { createAdapter } from '#shared/adapter.js';
import { orgScoped } from '#shared/presets/index.js';
import CrmNote from './note.model.js';
import crmNoteRepository from './note.repository.js';

// Notes share the activity permission block — same audience, same RBAC.
const crmNoteResource = defineResource({
  name: 'crm-note',
  displayName: 'CRM Notes',
  tag: 'CRM',
  prefix: '/crm/notes',
  // Notes are themselves authored log entries with timestamp + authorId —
  // a parallel `audit_logs` row per note is redundant and doubles storage.
  audit: false,

  adapter: createAdapter(CrmNote, crmNoteRepository),
  presets: [orgScoped],

  schemaOptions: {
    fieldRules: {
      organizationId: { systemManaged: true },
    },
  },

  queryParser: new QueryParser({
    maxLimit: 100,
    allowedFilterFields: ['subjectKind', 'subjectId', 'authorId'],
  }),

  permissions: crmPermissions.activity as unknown as Record<string, unknown>,
});

export default crmNoteResource;
