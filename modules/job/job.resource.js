/**
 * Job Resource Definition
 *
 * Job queue management for background processing.
 * Standard CRUD operations for viewing and monitoring job status.
 * Jobs are typically created by system processes, not via API.
 */

import { defineResource } from '@classytic/arc';
import { createAdapter } from '#shared/adapter.js';
import { getResourcePermissions } from '#shared/permissions.js';
import { queryParser } from '#shared/query-parser.js';
import Job from './job.model.js';
import jobRepository from './job.repository.js';
import jobController from './job.controller.js';
import jobSchemas from './schemas.js';
import { events } from './events.js';

const jobResource = defineResource({
  name: 'job',
  displayName: 'Jobs',
  tag: 'Job',
  prefix: '/jobs',

  adapter: createAdapter(Job, jobRepository),
  controller: jobController,
  queryParser,

  // Arc v1.0: Use disabledRoutes instead of empty permission arrays
  // Jobs are created by system processes, not via API
  disabledRoutes: ['create', 'update', 'delete'],
  permissions: getResourcePermissions('job'),
  schemaOptions: jobSchemas,

  events: events,
});

export default jobResource;
