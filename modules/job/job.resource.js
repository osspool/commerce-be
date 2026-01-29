/**
 * Job Resource Definition
 *
 * Job queue management for background processing.
 * Standard CRUD operations for viewing and monitoring job status.
 * Jobs are typically created by system processes, not via API.
 */

import { defineResource, createMongooseAdapter } from '@classytic/arc';
import { requireRoles } from '@classytic/arc/permissions';
import { queryParser } from '#shared/query-parser.js';
import Job from './job.model.js';
import jobRepository from './job.repository.js';
import jobController from './job.controller.js';
import permissions from '#config/permissions.js';
import jobSchemas from './schemas.js';
import { events } from './events.js';

const jobResource = defineResource({
  name: 'job',
  displayName: 'Jobs',
  tag: 'Job',
  prefix: '/jobs',

  adapter: createMongooseAdapter({
    model: Job,
    repository: jobRepository,
  }),
  controller: jobController,
  queryParser,

  // Arc v1.0: Use disabledRoutes instead of empty permission arrays
  // Jobs are created by system processes, not via API
  disabledRoutes: ['create', 'update', 'delete'],
  permissions: {
    list: requireRoles(['admin']),
    get: requireRoles(['admin']),
  },
  schemaOptions: jobSchemas,

  events: events,
});

export default jobResource;
