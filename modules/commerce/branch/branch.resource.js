/**
 * Branch Resource Definition
 *
 * Physical store/warehouse locations for multi-location inventory management.
 * Each branch can have its own stock levels, POS transactions, and settings.
 */

import { defineResource } from '#core/factories/ResourceDefinition.js';
import Branch from './branch.model.js';
import branchRepository from './branch.repository.js';
import branchController from './branch.controller.js';
import permissions from '#config/permissions.js';
import branchSchemas from './branch.schemas.js';
import { events } from './events.js';

const branchResource = defineResource({
  name: 'branch',
  displayName: 'Branches',
  tag: 'Branches',
  prefix: '/branches',

  model: Branch,
  repository: branchRepository,
  controller: branchController,

  permissions: permissions.branches,
  schemaOptions: branchSchemas,

  additionalRoutes: [
    {
      method: 'GET',
      path: '/code/:code',
      summary: 'Get branch by code',
      handler: 'getByCode',
      authRoles: permissions.branches.byCode,
      schemas: {
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
      authRoles: permissions.branches.default,
    },
    {
      method: 'POST',
      path: '/:id/set-default',
      summary: 'Set branch as default',
      handler: 'setDefault',
      authRoles: permissions.branches.setDefault,
      schemas: {
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

  events: events,
});

export default branchResource;
