/**
 * Size Guide Resource Definition
 *
 * Size guide templates for product measurements.
 * Standard CRUD operations + custom slug-based lookup for public display.
 */

import { defineResource } from '#core/factories/ResourceDefinition.js';
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

  model: SizeGuide,
  repository: sizeGuideRepository,
  controller: sizeGuideController,

  permissions: permissions.sizeGuides,
  schemaOptions: sizeGuideSchemas,

  additionalRoutes: [
    {
      method: 'GET',
      path: '/slug/:slug',
      summary: 'Get size guide by slug',
      handler: 'getBySlug',
      authRoles: null, // Public access
      schemas: {
        params: {
          type: 'object',
          properties: { slug: { type: 'string' } },
          required: ['slug'],
        },
      },
    },
  ],

  events: events,
});

export default sizeGuideResource;
