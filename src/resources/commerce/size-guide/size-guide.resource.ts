/**
 * Size Guide Resource Definition
 *
 * Size guide templates for product measurements.
 * Standard CRUD operations + custom slug-based lookup for public display.
 */

import { createMongooseAdapter, defineResource } from '@classytic/arc';
import { getResourcePermissions } from '#shared/permissions.js';
import { slugLookup } from '#shared/presets.js';
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

  // Preset adds: /slug/:slug route (public access)
  presets: [slugLookup],

  permissions: getResourcePermissions('sizeGuide'),
  customSchemas: {
    create: { body: sizeGuideSchemas.create.body },
    update: { body: sizeGuideSchemas.update.body },
  },

  events,
});

export default sizeGuideResource;
