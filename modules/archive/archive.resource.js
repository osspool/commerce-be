/**
 * Archive Resource Definition
 *
 * Archive management for orders, transactions, and other historical data.
 * Standard CRUD operations + custom archival workflows.
 */

import { defineResource, createMongooseAdapter } from '@classytic/arc';
import { queryParser } from '#shared/query-parser.js';
import Archive from './archive.model.js';
import archiveRepository from './archive.repository.js';
import archiveController from './archive.controller.js';
import permissions from '#config/permissions.js';
import archiveSchemas, { archiveRunQuery } from './schemas.js';
import { events } from './events.js';

const archiveResource = defineResource({
  name: 'archive',
  displayName: 'Archives',
  tag: 'Archive',
  prefix: '/archives',

  adapter: createMongooseAdapter({
    model: Archive,
    repository: archiveRepository,
  }),
  controller: archiveController,
  queryParser,

  permissions: permissions.transactions, // Archive uses transaction permissions
  schemaOptions: archiveSchemas,

  additionalRoutes: [
    {
      method: 'POST',
      path: '/run',
      summary: 'Run archive for orders or transactions and delete originals',
      handler: 'runArchive',
      permissions: permissions.transactions.delete,
      wrapHandler: false,
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
      wrapHandler: false,
      schema: {
        params: archiveSchemas.get?.params,
      },
    },
    {
      method: 'DELETE',
      path: '/purge/:id',
      summary: 'Superadmin purge archive and file',
      handler: 'purgeArchive',
      permissions: permissions.archive.purge,
      wrapHandler: false,
    },
  ],

  events: events,
});

export default archiveResource;
