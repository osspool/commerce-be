import { defineResource } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { QueryParser } from '@classytic/mongokit';
import { z } from 'zod';
import crmPermissions from '#config/permissions/crm.js';
import { orgScoped } from '#shared/presets/index.js';
import { convertLead, disqualifyLead, markLeadContacted, nurtureLead, qualifyLead } from './lead.actions.js';
import CrmLead from './lead.model.js';
import crmLeadRepository from './lead.repository.js';

// `.loose()` matches the comment below: "additionalProperties is permissive".
// Zod v4 defaults objects to strict in JSON Schema output, so without this the
// AJV `oneOf` validator rejects extras (e.g. convert payload's `amount`).
const emptyBody = z.object({}).loose();
const disqualifyBody = z.object({ reason: z.string().optional() }).loose();
const convertBody = z.object({ pipelineId: z.string().optional() }).loose();

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

  adapter: createMongooseAdapter(CrmLead, crmLeadRepository),
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
      schema: emptyBody,
    },
    qualify: {
      handler: qualifyLead,
      permissions: crmPermissions.lead.update,
      schema: emptyBody,
    },
    disqualify: {
      handler: disqualifyLead,
      permissions: crmPermissions.lead.update,
      schema: disqualifyBody,
    },
    nurture: {
      handler: nurtureLead,
      permissions: crmPermissions.lead.update,
      schema: emptyBody,
    },
    convert: {
      handler: convertLead,
      permissions: crmPermissions.lead.update,
      schema: convertBody,
    },
  },
});

export default crmLeadResource;
