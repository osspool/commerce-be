import { createMongooseAdapter, defineResource } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import { z } from 'zod';
import crmPermissions from '#config/permissions/crm.js';
import { orgScoped } from '#shared/presets/index.js';
import { abandonOpportunity, advanceOpportunity, loseOpportunity, winOpportunity } from './opportunity.actions.js';
import CrmOpportunity from './opportunity.model.js';
import crmOpportunityRepository from './opportunity.repository.js';

const emptyBody = z.object({});
const advanceBody = z.object({ stageId: z.string().optional() });
const loseBody = z.object({ lostReasonId: z.string().optional() });

const crmOpportunityResource = defineResource({
  name: 'crm-opportunity',
  displayName: 'CRM Opportunities',
  tag: 'CRM',
  prefix: '/crm/opportunities',
  audit: true,

  adapter: createMongooseAdapter(CrmOpportunity, crmOpportunityRepository),
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
      schema: advanceBody,
    },
    win: {
      handler: winOpportunity,
      permissions: crmPermissions.opportunity.update,
      schema: emptyBody,
    },
    lose: {
      handler: loseOpportunity,
      permissions: crmPermissions.opportunity.update,
      schema: loseBody,
    },
    abandon: {
      handler: abandonOpportunity,
      permissions: crmPermissions.opportunity.update,
      schema: emptyBody,
    },
  },
});

export default crmOpportunityResource;
