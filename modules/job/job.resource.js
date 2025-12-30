/**
 * Job Resource Definition
 *
 * Job queue management for background processing.
 * Standard CRUD operations for viewing and monitoring job status.
 * Jobs are typically created by system processes, not via API.
 */

import { defineResource } from '#core/factories/ResourceDefinition.js';
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

  model: Job,
  repository: jobRepository,
  controller: jobController,

  permissions: permissions.jobs || {
    list: ['admin'],
    get: ['admin'],
    create: [],
    update: [],
    remove: [],
  },
  schemaOptions: jobSchemas,

  events: events,
});

export default jobResource;
