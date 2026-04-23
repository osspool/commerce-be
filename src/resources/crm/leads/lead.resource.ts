import { defineResource } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import crmPermissions from '#config/permissions/crm.js';
import { createAdapter } from '#shared/adapter.js';
import { orgScoped } from '#shared/presets/index.js';
import { convertLead, disqualifyLead, markLeadContacted, nurtureLead, qualifyLead } from './lead.actions.js';
import CrmLead from './lead.model.js';
import crmLeadRepository from './lead.repository.js';

/**
 * Lead lifecycle transitions (`new → contacted → qualified → converted`,
 * plus disqualify / nurture) are exposed as Stripe-style Arc actions:
 * `POST /crm/leads/:id/action { "action": "qualify" }`.
 *
 * Arc's action body validator treats every field in the legacy field-map
 * as required by default. We only list fields that are strictly required
 * for the handler to make progress; optional parameters are forwarded by
 * Arc (additionalProperties is permissive) and parsed by the handler.
 */
const crmLeadResource = defineResource({
  name: 'crm-lead',
  displayName: 'CRM Leads',
  tag: 'CRM',
  prefix: '/crm/leads',
  audit: true,

  adapter: createAdapter(CrmLead, crmLeadRepository),
  presets: [orgScoped],

  // `fullName` is client-provided. `status` / `statusHistory` / `score` and
  // the `converted*` link fields are owned by `LeadService`, so they're
  // excluded from the client-facing write schema.
  schemaOptions: {
    fieldRules: {
      organizationId: { systemManaged: true },
      status: { systemManaged: true },
      statusHistory: { systemManaged: true },
      score: { systemManaged: true },
      convertedContactId: { systemManaged: true },
      convertedAccountId: { systemManaged: true },
      convertedOpportunityId: { systemManaged: true },
      convertedAt: { systemManaged: true },
    },
  },

  queryParser: new QueryParser({
    maxLimit: 100,
    allowedFilterFields: ['status', 'source', 'ownerId', 'email', 'score', 'tags'],
  }),

  permissions: crmPermissions.lead as unknown as Record<string, unknown>,

  actions: {
    markContacted: {
      handler: markLeadContacted,
      permissions: crmPermissions.lead.update,
      schema: {},
    },
    qualify: {
      handler: qualifyLead,
      permissions: crmPermissions.lead.update,
      schema: {},
    },
    disqualify: {
      handler: disqualifyLead,
      permissions: crmPermissions.lead.update,
      schema: {
        reason: { type: 'string', description: 'Why the lead is being disqualified' },
      },
    },
    nurture: {
      handler: nurtureLead,
      permissions: crmPermissions.lead.update,
      schema: {},
    },
    convert: {
      handler: convertLead,
      permissions: crmPermissions.lead.update,
      schema: {
        pipelineId: { type: 'string', description: 'Target pipeline id' },
      },
    },
  },
});

export default crmLeadResource;
