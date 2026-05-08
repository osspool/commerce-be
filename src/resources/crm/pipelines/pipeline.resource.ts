import { defineResource } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { QueryParser } from '@classytic/mongokit';
import crmPermissions from '#config/permissions/crm.js';
import { orgScoped } from '#shared/presets/index.js';
import CrmPipeline from './pipeline.model.js';
import crmPipelineRepository from './pipeline.repository.js';

// Reuse account-tier permissions for pipeline admin — same audience.
const crmPipelineResource = defineResource({
  name: 'crm-pipeline',
  displayName: 'CRM Pipelines',
  tag: 'CRM',
  prefix: '/crm/pipelines',
  audit: true,

  adapter: createMongooseAdapter(CrmPipeline, crmPipelineRepository),

  schemaOptions: {
    fieldRules: {
      organizationId: { systemManaged: true },
    },
  },

  queryParser: new QueryParser({
    maxLimit: 50,
    allowedFilterFields: ['isArchived', 'teamRef', 'name'],
  }),

  permissions: crmPermissions.account as unknown as Record<string, unknown>,
});

export default crmPipelineResource;
