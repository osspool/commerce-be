/**
 * Branch Resource Definition
 *
 * Physical store/warehouse locations for multi-location inventory management.
 * Each branch can have its own stock levels, POS transactions, and settings.
 */

import { defineResource } from '@classytic/arc';
import { createAdapter } from '#shared/adapter.js';
import { getResourcePermissions } from '#shared/permissions.js';
import { queryParser } from '#shared/query-parser.js';
import Branch from './branch.model.js';
import branchRepository from './branch.repository.js';
import branchController from './branch.controller.js';
import permissions from '#config/permissions.js';
import branchSchemas, { branchSchemaOptions } from './branch.schemas.js';
import { events } from './events.js';
import { toArcSchemas } from '#shared/event-helpers.js';

const branchResource = defineResource({
  name: 'branch',
  audit: true,
  displayName: 'Branches',
  tag: 'Branches',
  prefix: '/branches',

  adapter: createAdapter(Branch, branchRepository),
  controller: branchController,
  queryParser,

  permissions: getResourcePermissions('branch'),

  cache: {
    staleTime: 30,
    gcTime: 180,
    tags: ['branches'],
  },
  schemaOptions: branchSchemaOptions,
  customSchemas: toArcSchemas(branchSchemas),

  additionalRoutes: [
    {
      method: 'GET',
      path: '/code/:code',
      summary: 'Get branch by code',
      handler: 'getByCode',
      permissions: permissions.branches.getByCode,
      wrapHandler: false,
      schema: {
        params: {
          type: 'object',
          properties: {
            code: { type: 'string' },
          },
          required: ['code'],
        },
      },
    },
    {
      method: 'GET',
      path: '/default',
      summary: 'Get default branch (auto-creates if none exists)',
      handler: 'getDefault',
      permissions: permissions.branches.getDefault,
      wrapHandler: false,
    },
    {
      method: 'POST',
      path: '/:id/set-default',
      summary: 'Set branch as default',
      handler: 'setDefault',
      permissions: permissions.branches.setDefault,
      wrapHandler: false,
      schema: {
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
      },
    },
  ],

  events,
});

export default branchResource;
