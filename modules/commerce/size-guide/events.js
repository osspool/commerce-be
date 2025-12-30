/**
 * Size Guide Domain Events
 *
 * Events emitted by the size guide module for lifecycle tracking.
 */

export const events = {
  'size-guide:created': {
    module: 'commerce/size-guide',
    description: 'Emitted when a new size guide template is created',
    schema: {
      type: 'object',
      required: ['sizeGuideId', 'name', 'slug'],
      properties: {
        sizeGuideId: { type: 'string', description: 'Size guide ID' },
        name: { type: 'string', description: 'Size guide name' },
        slug: { type: 'string', description: 'URL-friendly slug' },
        measurementUnit: {
          type: 'string',
          enum: ['inches', 'cm'],
          description: 'Unit of measurement',
        },
        isActive: { type: 'boolean', description: 'Active status' },
      },
    },
  },

  'size-guide:updated': {
    module: 'commerce/size-guide',
    description: 'Emitted when a size guide template is updated',
    schema: {
      type: 'object',
      required: ['sizeGuideId'],
      properties: {
        sizeGuideId: { type: 'string', description: 'Size guide ID' },
        changes: {
          type: 'object',
          description: 'Fields that were updated',
        },
      },
    },
  },

  'size-guide:deleted': {
    module: 'commerce/size-guide',
    description: 'Emitted when a size guide template is deleted (soft delete)',
    schema: {
      type: 'object',
      required: ['sizeGuideId', 'slug'],
      properties: {
        sizeGuideId: { type: 'string', description: 'Size guide ID' },
        slug: { type: 'string', description: 'Size guide slug' },
        name: { type: 'string', description: 'Size guide name' },
      },
    },
  },
};

export const handlers = {
  // Size guide module doesn't subscribe to other events yet
  // Can add handlers here if needed in the future
};
