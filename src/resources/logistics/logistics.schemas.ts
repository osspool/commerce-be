/**
 * Logistics Schemas
 *
 * JSON schemas for OpenAPI documentation and validation.
 */

// ============================================
// LOCATION SCHEMAS
// ============================================

export const getDivisionsSchema = {
  response: {
    200: {
      description: 'List of divisions',
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              nameLocal: { type: 'string' },
            },
          },
        },
      },
    },
  },
} as const;

export const getDistrictsSchema = {
  params: {
    type: 'object',
    properties: {
      division: { type: 'string', description: 'Division ID' },
    },
    required: ['division'],
  },
  response: {
    200: {
      description: 'List of districts in division',
    },
  },
} as const;

export const getAreasSchema = {
  querystring: {
    type: 'object',
    properties: {
      zoneId: {
        type: 'number',
        description: 'Filter by zone ID (1-6)',
      },
      district: {
        type: 'string',
        description: 'Filter by district ID (e.g., "dhaka", "gazipur")',
      },
    },
  },
} as const;

export const searchAreasSchema = {
  querystring: {
    type: 'object',
    properties: {
      q: { type: 'string', minLength: 2, description: 'Search query (min 2 chars)' },
      limit: { type: 'number', default: 20, description: 'Max results' },
    },
    required: ['q'],
  },
} as const;

export const getZonesSchema = {
  response: {
    200: {
      description: 'Delivery zones with pricing',
    },
  },
} as const;

export const estimateChargeSchema = {
  querystring: {
    type: 'object',
    properties: {
      areaId: { type: 'number', description: 'Delivery area ID' },
      amount: { type: 'number', description: 'COD amount (for COD charge calculation)' },
    },
    required: ['areaId'],
  },
} as const;

export const calculateChargeSchema = {
  querystring: {
    type: 'object',
    properties: {
      deliveryAreaId: {
        type: 'number',
        description: 'Delivery area internalId from bd-areas (resolved to provider-specific ID)',
      },
      pickupAreaId: { type: 'number', description: 'Pickup area internalId (uses platform default if not provided)' },
      amount: { type: 'number', description: 'Cash collection amount in BDT (COD amount, use 0 for prepaid orders)' },
      weight: { type: 'number', description: 'Parcel weight in grams (default: 500g)' },
      provider: {
        type: 'string',
        enum: ['redx', 'pathao', 'steadfast'],
        description: 'Specific provider (uses default if not specified)',
      },
    },
    required: ['deliveryAreaId', 'amount'],
  },
} as const;

// ============================================
// CONFIG SCHEMAS
// ============================================

export const getConfigSchema = {
  response: {
    200: {
      description: 'Logistics configuration',
    },
  },
} as const;

export const updateConfigSchema = {
  body: {
    type: 'object',
    properties: {
      defaultProvider: {
        type: 'string',
        enum: ['redx', 'pathao', 'steadfast', 'paperfly'],
      },
    },
  },
} as const;

export const addProviderSchema = {
  body: {
    type: 'object',
    properties: {
      provider: {
        type: 'string',
        enum: ['redx', 'pathao', 'steadfast', 'paperfly'],
        description: 'Provider name',
      },
      apiUrl: { type: 'string', description: 'Provider API base URL' },
      apiKey: { type: 'string', description: 'API key/token' },
      isActive: { type: 'boolean', default: true },
      isDefault: { type: 'boolean', default: false },
      settings: { type: 'object', description: 'Provider-specific settings' },
    },
    required: ['provider', 'apiKey'],
  },
} as const;

export const updateProviderSchema = {
  params: {
    type: 'object',
    properties: {
      provider: { type: 'string', description: 'Provider name' },
    },
    required: ['provider'],
  },
  body: {
    type: 'object',
    properties: {
      apiUrl: { type: 'string' },
      apiKey: { type: 'string' },
      isActive: { type: 'boolean' },
      isDefault: { type: 'boolean' },
      settings: { type: 'object' },
    },
  },
} as const;

// ============================================
// SHIPMENT SCHEMAS
// ============================================

export const createShipmentSchema = {
  body: {
    type: 'object',
    properties: {
      orderId: { type: 'string', description: 'Order ID to create shipment for' },
      provider: {
        type: 'string',
        enum: ['redx', 'pathao', 'steadfast'],
        description: 'Shipping provider (uses default if not specified)',
      },
      deliveryAreaId: { type: 'number', description: 'Delivery area internalId (uses order address if not provided)' },
      deliveryAreaName: { type: 'string', description: 'Delivery area name' },
      providerAreaId: {
        type: 'number',
        description: 'Provider-specific area ID (resolved from deliveryAreaId if not provided)',
      },
      pickupStoreId: { type: 'number', description: 'Pickup store ID (uses platform default if not provided)' },
      pickupAreaId: { type: 'number', description: 'Pickup area internalId (uses platform default if not provided)' },
      weight: { type: 'number', description: 'Parcel weight in grams (uses order parcel weight or default 500g)' },
      codAmount: {
        type: 'number',
        description: 'COD amount to collect on delivery (auto-calculated from order if not provided, 0 for prepaid)',
      },
      instructions: { type: 'string', description: 'Delivery instructions for courier' },
    },
    required: ['orderId'],
  },
} as const;

export const getShipmentSchema = {
  params: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Shipment ID' },
    },
    required: ['id'],
  },
} as const;

export const trackShipmentSchema = {
  params: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Shipment ID' },
    },
    required: ['id'],
  },
} as const;

export const updateShipmentStatusSchema = {
  params: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Shipment ID' },
    },
    required: ['id'],
  },
  body: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: [
          'pickup-requested',
          'pickup-pending',
          'picked-up',
          'in-transit',
          'out-for-delivery',
          'delivered',
          'returned',
          'cancelled',
          'on-hold',
        ],
        description: 'New shipment status',
      },
      message: { type: 'string', description: 'Status message' },
      messageLocal: { type: 'string', description: 'Localized status message' },
    },
    required: ['status'],
  },
} as const;

export const cancelShipmentSchema = {
  params: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Shipment ID' },
    },
    required: ['id'],
  },
  body: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Cancellation reason' },
    },
  },
} as const;

// ============================================
// PICKUP STORE SCHEMAS
// ============================================

export const getPickupStoresSchema = {
  querystring: {
    type: 'object',
    properties: {
      provider: { type: 'string', description: 'Filter by provider' },
    },
  },
} as const;

// ============================================
// WEBHOOK SCHEMA
// ============================================

export const webhookSchema = {
  params: {
    type: 'object',
    properties: {
      provider: { type: 'string', description: 'Provider name' },
    },
    required: ['provider'],
  },
} as const;

// ============================================
// HEALTH SCHEMAS
// ============================================

export const circuitStatusSchema = {
  response: {
    200: {
      description: 'Circuit breaker status for all providers',
    },
  },
} as const;

export const resetCircuitSchema = {
  params: {
    type: 'object',
    properties: {
      provider: { type: 'string', description: 'Provider name' },
    },
    required: ['provider'],
  },
} as const;
