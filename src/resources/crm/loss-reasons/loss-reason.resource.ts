import { defineResource } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import crmPermissions from '#config/permissions/crm.js';
import { createAdapter } from '#shared/adapter.js';
import { orgScoped } from '#shared/presets/index.js';
import CrmLossReason from './loss-reason.model.js';
import crmLossReasonRepository from './loss-reason.repository.js';

// Loss reasons are seed data for win/loss analytics — admin-scoped like pipelines.
const crmLossReasonResource = defineResource({
  name: 'crm-loss-reason',
  displayName: 'CRM Loss Reasons',
  tag: 'CRM',
  prefix: '/crm/loss-reasons',
  audit: true,

  adapter: createAdapter(CrmLossReason, crmLossReasonRepository),
  presets: [orgScoped],

  schemaOptions: {
    fieldRules: {
      organizationId: { systemManaged: true },
    },
  },

  queryParser: new QueryParser({
    maxLimit: 100,
    allowedFilterFields: ['active', 'category'],
  }),

  permissions: crmPermissions.account as unknown as Record<string, unknown>,
});

export default crmLossReasonResource;
