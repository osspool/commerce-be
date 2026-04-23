import { defineResource } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import crmPermissions from '#config/permissions/crm.js';
import { createAdapter } from '#shared/adapter.js';
import { orgScoped } from '#shared/presets/index.js';
import { abandonOpportunity, advanceOpportunity, loseOpportunity, winOpportunity } from './opportunity.actions.js';
import CrmOpportunity from './opportunity.model.js';
import crmOpportunityRepository from './opportunity.repository.js';

const crmOpportunityResource = defineResource({
  name: 'crm-opportunity',
  displayName: 'CRM Opportunities',
  tag: 'CRM',
  prefix: '/crm/opportunities',
  audit: true,

  adapter: createAdapter(CrmOpportunity, crmOpportunityRepository),
  presets: [orgScoped],

  schemaOptions: {
    fieldRules: {
      organizationId: { systemManaged: true },
      status: { systemManaged: true },
      statusHistory: { systemManaged: true },
      closedAt: { systemManaged: true },
      lostReasonId: { systemManaged: true },
    },
  },

  queryParser: new QueryParser({
    maxLimit: 100,
    allowedFilterFields: [
      'status',
      'pipelineId',
      'stageId',
      'ownerId',
      'accountId',
      'primaryContactId',
      'sourceLeadId',
      'tags',
    ],
  }),

  permissions: crmPermissions.opportunity as unknown as Record<string, unknown>,

  actions: {
    advanceToStage: {
      handler: advanceOpportunity,
      permissions: crmPermissions.opportunity.update,
      schema: {
        stageId: { type: 'string', description: 'Target stage id on the pipeline' },
      },
    },
    win: {
      handler: winOpportunity,
      permissions: crmPermissions.opportunity.update,
      schema: {},
    },
    lose: {
      handler: loseOpportunity,
      permissions: crmPermissions.opportunity.update,
      schema: {
        lostReasonId: { type: 'string', description: 'Required — ref to crm_loss_reasons' },
      },
    },
    abandon: {
      handler: abandonOpportunity,
      permissions: crmPermissions.opportunity.update,
      schema: {},
    },
  },
});

export default crmOpportunityResource;
