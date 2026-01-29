/**
 * Product Module Events
 */

import { publish } from '#lib/events/arcEvents.js';

export const events = {
  'product:created': {
    module: 'commerce/product',
    description: 'Emitted when a new product is created',
    schema: {
      type: 'object',
      required: ['productId', 'sku'],
      properties: {
        productId: { type: 'string', format: 'objectId' },
        sku: { type: 'string' },
        name: { type: 'string' },
        productType: { type: 'string', enum: ['simple', 'variant'] }
      }
    }
  },

  'product:updated': {
    module: 'commerce/product',
    description: 'Emitted when product is updated',
    schema: {
      type: 'object',
      required: ['productId'],
      properties: {
        productId: { type: 'string' },
        changes: { type: 'object' }
      }
    }
  },

  'product:deleted': {
    module: 'commerce/product',
    description: 'Emitted when product is soft-deleted',
    schema: {
      type: 'object',
      required: ['productId'],
      properties: {
        productId: { type: 'string' },
        sku: { type: 'string' }
      }
    }
  },

  'product:restored': {
    module: 'commerce/product',
    description: 'Emitted when deleted product is restored',
    schema: {
      type: 'object',
      required: ['productId'],
      properties: {
        productId: { type: 'string' },
        sku: { type: 'string' }
      }
    }
  },

  'product:variants.changed': {
    module: 'commerce/product',
    description: 'Emitted when product variants are updated',
    schema: {
      type: 'object',
      required: ['productId'],
      properties: {
        productId: { type: 'string' },
        disabledSkus: { type: 'array', items: { type: 'string' } },
        enabledSkus: { type: 'array', items: { type: 'string' } }
      }
    }
  },

  'product:category.changed': {
    module: 'commerce/product',
    description: 'Emitted when a product category reference changes (for maintaining category counts, etc.)',
    schema: {
      type: 'object',
      required: ['productId'],
      properties: {
        productId: { type: 'string' },
        previousCategory: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        newCategory: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      }
    }
  },

  'product:before.purge': {
    module: 'commerce/product',
    description: 'Emitted before product is permanently deleted',
    schema: {
      type: 'object',
      required: ['productId'],
      properties: {
        productId: { type: 'string' },
        snapshot: { type: 'object' }
      }
    }
  },

  'product:purged': {
    module: 'commerce/product',
    description: 'Emitted after product is permanently deleted',
    schema: {
      type: 'object',
      required: ['productId'],
      properties: {
        productId: { type: 'string' },
        sku: { type: 'string' },
        category: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      }
    }
  }
};

export const handlers = {};

// Helper functions (optional convenience for other modules)
export function emitProductCreated(payload) {
  void publish('product:created', payload);
}
