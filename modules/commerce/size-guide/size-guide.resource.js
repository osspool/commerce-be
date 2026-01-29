/**
 * Size Guide Resource Definition
 *
 * Size guide templates for product measurements.
 * Standard CRUD operations + custom slug-based lookup for public display.
 */

import { defineResource, createMongooseAdapter } from '@classytic/arc';
import { queryParser } from '#shared/query-parser.js';
import SizeGuide from './size-guide.model.js';
import sizeGuideRepository from './size-guide.repository.js';
import sizeGuideController from './size-guide.controller.js';
import permissions from '#config/permissions.js';
import sizeGuideSchemas from './size-guide.schemas.js';
import { events } from './events.js';

const sizeGuideResource = defineResource({
  name: 'size-guide',
  displayName: 'Size Guides',
  tag: 'Size Guides',
  prefix: '/size-guides',

  adapter: createMongooseAdapter({
    model: SizeGuide,
    repository: sizeGuideRepository,
  }),
  controller: sizeGuideController,
  queryParser,

  // Preset adds: /slug/:slug route (public access)
  presets: ['slugLookup'],

  permissions: permissions.sizeGuides,
  schemaOptions: sizeGuideSchemas,

  events: events,
});

export default sizeGuideResource;
