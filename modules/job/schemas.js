import Job from './job.model.js';
import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';

/**
 * Job CRUD Schemas with Field Rules
 *
 * Field Rules:
 * - All execution fields are systemManaged (jobs are managed by queue system)
 * - Users can view jobs but cannot create/update directly
 */
const crudSchemas = buildCrudSchemasFromModel(Job, {
  fieldRules: {
    status: { systemManaged: true },
    lastRun: { systemManaged: true },
    startedAt: { systemManaged: true },
    completedAt: { systemManaged: true },
    error: { systemManaged: true },
    metadata: { systemManaged: true },
  },
  query: {
    filterableFields: {
      type: 'string',
      organization: 'ObjectId',
      status: 'string',
    },
  },
});

// Export schema options for controller
export const jobSchemaOptions = {
  query: {
    allowedPopulate: ['organization'],
    filterableFields: {
      type: 'string',
      organization: 'ObjectId',
      status: 'string',
    },
  },
};

export default crudSchemas;
