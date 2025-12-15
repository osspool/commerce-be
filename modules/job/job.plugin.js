import fp from 'fastify-plugin';
import createCrudRouter from '#routes/utils/createCrudRouter.js';
import jobController from './job.controller.js';
import jobSchemas from './schemas.js';
import permissions from '#config/permissions.js';

/**
 * Job Plugin
 * Provides CRUD operations for job queue monitoring
 *
 * Jobs are system-managed entities for background processing.
 * This module is mainly for viewing and monitoring job status.
 */
async function jobPlugin(fastify, opts) {
  await fastify.register(async (instance) => {
    createCrudRouter(instance, jobController, {
      tag: 'Job',
      schemas: jobSchemas,
      auth: permissions.jobs || { list: ['admin'], get: ['admin'], create: [], update: [], remove: [] },
    });
  }, { prefix: '/jobs' });
}

export default fp(jobPlugin, { name: 'job-plugin' });