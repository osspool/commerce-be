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
};

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
};

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
};

export const searchAreasSchema = {
  querystring: {
    type: 'object',
    properties: {
      q: { type: 'string', minLength: 2, description: 'Search query (min 2 chars)' },
      limit: { type: 'number', default: 20, description: 'Max results' },
    },
    required: ['q'],
  },
};

export const getZonesSchema = {
  response: {
    200: {
      description: 'Delivery zones with pricing',
    },
  },
};

export const estimateChargeSchema = {
  querystring: {
    type: 'object',
    properties: {
      areaId: { type: 'number', description: 'Delivery area ID' },
      amount: { type: 'number', description: 'COD amount (for COD charge calculation)' },
    },
    required: ['areaId'],
  },
};

export const calculateChargeSchema = {
  querystring: {
    type: 'object',
    properties: {
      deliveryAreaId: { type: 'number', description: 'Delivery area internalId from bd-areas (resolved to provider-specific ID)' },
      pickupAreaId: { type: 'number', description: 'Pickup area internalId (uses platform default if not provided)' },
      amount: { type: 'number', description: 'Cash collection amount in BDT (COD amount, use 0 for prepaid orders)' },
      weight: { type: 'number', description: 'Parcel weight in grams (default: 500g)' },
      provider: { type: 'string', enum: ['redx', 'pathao', 'steadfast'], description: 'Specific provider (uses default if not specified)' },
    },
    required: ['deliveryAreaId', 'amount'],
  },
};

// ============================================
// CONFIG SCHEMAS
// ============================================

export const getConfigSchema = {
  response: {
    200: {
      description: 'Logistics configuration',
    },
  },
};

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
};

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
};

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
};

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
      providerAreaId: { type: 'number', description: 'Provider-specific area ID (resolved from deliveryAreaId if not provided)' },
      pickupStoreId: { type: 'number', description: 'Pickup store ID (uses platform default if not provided)' },
      pickupAreaId: { type: 'number', description: 'Pickup area internalId (uses platform default if not provided)' },
      weight: { type: 'number', description: 'Parcel weight in grams (uses order parcel weight or default 500g)' },
      instructions: { type: 'string', description: 'Delivery instructions for courier' },
    },
    required: ['orderId'],
  },
};

export const getShipmentSchema = {
  params: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Shipment ID' },
    },
    required: ['id'],
  },
};

export const trackShipmentSchema = {
  params: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Shipment ID' },
    },
    required: ['id'],
  },
};

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
        enum: ['pickup-requested', 'pickup-pending', 'picked-up', 'in-transit', 'out-for-delivery', 'delivered', 'returned', 'cancelled', 'on-hold'],
        description: 'New shipment status',
      },
      message: { type: 'string', description: 'Status message' },
      messageLocal: { type: 'string', description: 'Localized status message' },
    },
    required: ['status'],
  },
};

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
};

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
};

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
};

// ============================================
// HEALTH SCHEMAS
// ============================================

export const circuitStatusSchema = {
  response: {
    200: {
      description: 'Circuit breaker status for all providers',
    },
  },
};

export const resetCircuitSchema = {
  params: {
    type: 'object',
    properties: {
      provider: { type: 'string', description: 'Provider name' },
    },
    required: ['provider'],
  },
};
