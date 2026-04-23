/**
 * Archive Resource Definition
 *
 * Archive management for orders, transactions, and other historical data.
 * Standard CRUD operations + custom archival workflows.
 */

import { defineResource } from '@classytic/arc';
import permissions from '#config/permissions.js';
import { createAdapter } from '#shared/adapter.js';
import { toArcSchemas } from '#shared/event-helpers.js';
import { archiveActions, getResourcePermissions } from '#shared/permissions.js';
import { queryParser } from '#shared/query-parser.js';
import archiveController from './archive.controller.js';
import Archive from './archive.model.js';
import archiveRepository from './archive.repository.js';
import { events } from './events.js';
import archiveSchemas, { archiveRunQuery, archiveSchemaOptions } from './schemas.js';

const archiveResource = defineResource({
  name: 'archive',
  displayName: 'Archives',
  tag: 'Archive',
  prefix: '/archives',

  adapter: createAdapter(Archive, archiveRepository),
  controller: archiveController,
  queryParser,

  permissions: getResourcePermissions('archive'),
  schemaOptions: archiveSchemaOptions,
  customSchemas: toArcSchemas(archiveSchemas),

  routes: [
    {
      method: 'POST',
      path: '/run',
      summary: 'Run archive for orders or transactions and delete originals',
      handler: 'runArchive',
      permissions: permissions.transactions.delete,
      raw: true,
      schema: {
        body: archiveRunQuery,
      },
    },
    {
      method: 'GET',
      path: '/download/:id',
      summary: 'Download archive file',
      handler: 'downloadArchive',
      permissions: permissions.transactions.get,
      raw: true,
      schema: {
        params: archiveSchemas.params,
      },
    },
    {
      method: 'DELETE',
      path: '/purge/:id',
      summary: 'Superadmin purge archive and file',
      handler: 'purgeArchive',
      permissions: archiveActions.purge,
      raw: true,
    },
  ],

  events,
});

export default archiveResource;
