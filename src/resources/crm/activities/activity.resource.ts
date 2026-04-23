import { defineResource } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import crmPermissions from '#config/permissions/crm.js';
import { createAdapter } from '#shared/adapter.js';
import { orgScoped } from '#shared/presets/index.js';
import { cancelActivity, completeActivity } from './activity.actions.js';
import CrmActivity from './activity.model.js';
import crmActivityRepository from './activity.repository.js';

const crmActivityResource = defineResource({
  name: 'crm-activity',
  displayName: 'CRM Activities',
  tag: 'CRM',
  prefix: '/crm/activities',
  // Activities ARE the activity log — every row is a timestamped record of a
  // call / email / meeting / task. Duplicating that into `audit_logs` wastes
  // space for no added signal.
  audit: false,

  adapter: createAdapter(CrmActivity, crmActivityRepository),
  presets: [orgScoped],

  schemaOptions: {
    fieldRules: {
      organizationId: { systemManaged: true },
      status: { systemManaged: true },
      completedAt: { systemManaged: true },
      cancelledAt: { systemManaged: true },
    },
  },

  queryParser: new QueryParser({
    maxLimit: 100,
    allowedFilterFields: ['type', 'status', 'subjectKind', 'subjectId', 'ownerId'],
  }),

  permissions: crmPermissions.activity as unknown as Record<string, unknown>,

  actions: {
    complete: {
      handler: completeActivity,
      permissions: crmPermissions.activity.update,
      schema: {},
    },
    cancel: {
      handler: cancelActivity,
      permissions: crmPermissions.activity.update,
      schema: {},
    },
  },
});

export default crmActivityResource;
