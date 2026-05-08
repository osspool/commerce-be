/**
 * Size Guide Resource Definition
 *
 * Size guide templates for product measurements. Standard CRUD only —
 * the storefront resolves slugs client-side from the cached list, so the
 * `/slug/:slug` preset route was unused and is intentionally not registered.
 */

import { defineResource } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { getResourcePermissions } from '#shared/permissions.js';
import { queryParser } from '#shared/query-parser.js';
import { events } from './events.js';
import sizeGuideController from './size-guide.controller.js';
import SizeGuide from './size-guide.model.js';
import sizeGuideRepository from './size-guide.repository.js';
import sizeGuideSchemas from './size-guide.schemas.js';

const sizeGuideResource = defineResource({
  name: 'size-guide',
  displayName: 'Size Guides',
  tag: 'Size Guides',
  prefix: '/size-guides',

  adapter: createMongooseAdapter(SizeGuide, sizeGuideRepository),
  controller: sizeGuideController,
  queryParser,

  permissions: getResourcePermissions('sizeGuide'),
  customSchemas: {
    create: { body: sizeGuideSchemas.create.body },
    update: { body: sizeGuideSchemas.update.body },
  },

  events,
});

export default sizeGuideResource;
