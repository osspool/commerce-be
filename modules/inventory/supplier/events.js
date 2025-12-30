/**
 * Supplier Events
 *
 * Domain events emitted by the supplier submodule.
 */

export const events = {
  'supplier:created': {
    module: 'inventory/supplier',
    description: 'Supplier created',
    schema: {
      type: 'object',
      required: ['supplierId'],
      properties: {
        supplierId: { type: 'string' },
        code: { type: 'string' },
        name: { type: 'string' },
        type: { type: 'string' },
        createdBy: { type: 'string' },
      },
    },
  },

  'supplier:updated': {
    module: 'inventory/supplier',
    description: 'Supplier updated',
    schema: {
      type: 'object',
      required: ['supplierId'],
      properties: {
        supplierId: { type: 'string' },
        changes: { type: 'object' },
        updatedBy: { type: 'string' },
      },
    },
  },

  'supplier:deactivated': {
    module: 'inventory/supplier',
    description: 'Supplier deactivated',
    schema: {
      type: 'object',
      required: ['supplierId'],
      properties: {
        supplierId: { type: 'string' },
        reason: { type: 'string' },
        deactivatedBy: { type: 'string' },
      },
    },
  },
};

export const handlers = {};

export default events;
