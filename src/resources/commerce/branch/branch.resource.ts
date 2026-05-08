/**
 * Branch Resource Definition
 *
 * Physical store/warehouse locations for multi-location inventory management.
 * Each branch can have its own stock levels, POS transactions, and settings.
 */

import { defineResource } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { z } from 'zod';
import permissions from '#config/permissions.js';
import { toArcSchemas } from '#shared/event-helpers.js';
import { getResourcePermissions } from '#shared/permissions.js';
import { queryParser } from '#shared/query-parser.js';
import branchController from './branch.controller.js';
import Branch from './branch.model.js';
import branchRepository from './branch.repository.js';
import branchSchemas from './branch.schemas.js';
import { events } from './events.js';

const codeParams = z.object({ code: z.string() });
const idParams = z.object({ id: z.string() });

const branchResource = defineResource({
  name: 'branch',
  audit: true,
  displayName: 'Branches',
  tag: 'Branches',
  prefix: '/branches',

  adapter: createMongooseAdapter(Branch, branchRepository),
  controller: branchController,
  queryParser,

  permissions: getResourcePermissions('branch'),

  customSchemas: toArcSchemas(branchSchemas),

  routes: [
    {
      method: 'GET',
      path: '/code/:code',
      summary: 'Get branch by code',
      handler: 'getByCode',
      permissions: permissions.branches.getByCode,
      raw: true,
      schema: { params: codeParams },
    },
    {
      method: 'GET',
      path: '/default',
      summary: 'Get default branch (auto-creates if none exists)',
      handler: 'getDefault',
      permissions: permissions.branches.getDefault,
      raw: true,
    },
    {
      method: 'POST',
      path: '/:id/set-default',
      summary: 'Set branch as default',
      handler: 'setDefault',
      permissions: permissions.branches.setDefault,
      raw: true,
      schema: { params: idParams },
    },
  ],

  events,
});

export default branchResource;
