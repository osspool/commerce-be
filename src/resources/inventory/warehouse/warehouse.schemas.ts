/**
 * Warehouse Schemas (Zod v4)
 *
 * Request/response validation + auto OpenAPI docs for
 * Node (warehouse), Location, and Audit endpoints.
 */
import { z } from 'zod';

// ── Shared ──

const idParam = z.object({ id: z.string() });

const successData = <T extends z.ZodType>(schema: T) => z.object({ success: z.literal(true), data: schema });

// ── Node (Warehouse) ──

const nodeEntity = z.object({
  _id: z.string(),
  organizationId: z.string(),
  code: z.string(),
  name: z.string(),
  type: z.string(),
  status: z.enum(['active', 'inactive']),
  timezone: z.string().optional(),
  currency: z.string().optional(),
  address: z
    .object({
      street: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      postalCode: z.string().optional(),
      country: z.string().optional(),
      coordinates: z.object({ lat: z.number(), lng: z.number() }).optional(),
    })
    .optional(),
  capabilities: z.array(z.string()).optional(),
  isDefault: z.boolean().optional(),
});

export const nodeSchemas = {
  create: {
    body: z.object({
      code: z.string().min(1).describe('Unique code (e.g. WH-01)'),
      name: z.string().min(1).describe('Display name'),
      type: z.enum(['warehouse', 'store', 'fulfillment_center', 'returns_center']).default('warehouse'),
      timezone: z.string().optional(),
      currency: z.string().optional(),
      address: z
        .object({
          street: z.string().optional(),
          city: z.string().optional(),
          state: z.string().optional(),
          postalCode: z.string().optional(),
          country: z.string().optional(),
          coordinates: z.object({ lat: z.number(), lng: z.number() }).optional(),
        })
        .optional(),
      capabilities: z.array(z.string()).optional(),
      isDefault: z.boolean().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
    response: { 201: successData(nodeEntity) },
  },
  update: {
    params: idParam,
    body: z.object({
      name: z.string().optional(),
      status: z.enum(['active', 'inactive']).optional(),
      timezone: z.string().optional(),
      address: z
        .object({
          street: z.string().optional(),
          city: z.string().optional(),
          state: z.string().optional(),
          postalCode: z.string().optional(),
          country: z.string().optional(),
          coordinates: z.object({ lat: z.number(), lng: z.number() }).optional(),
        })
        .optional(),
      capabilities: z.array(z.string()).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  },
};

// ── Location ──

const coordinatesSchema = z.object({
  zone: z.string().optional(),
  aisle: z.number().optional(),
  bay: z.number().optional(),
  level: z.number().optional(),
  bin: z.string().optional(),
});

const locationEntity = z.object({
  _id: z.string(),
  organizationId: z.string(),
  nodeId: z.string(),
  parentLocationId: z.string().optional(),
  code: z.string(),
  name: z.string(),
  type: z.string(),
  status: z.enum(['active', 'inactive']),
  barcode: z.string().optional(),
  coordinates: coordinatesSchema.optional(),
  maxWeight: z.number().optional(),
  maxVolume: z.number().optional(),
  sortOrder: z.number().optional(),
});

export const locationSchemas = {
  list: {
    querystring: z.object({
      nodeId: z.string().optional().describe('Filter by warehouse node'),
      type: z.string().optional().describe('Filter by location type'),
      parentLocationId: z.string().optional().describe('Filter by parent location'),
      status: z.enum(['active', 'inactive']).optional(),
    }),
  },
  create: {
    body: z.object({
      nodeId: z.string().describe('Warehouse node ID'),
      parentLocationId: z.string().optional().describe('Parent location (for hierarchy)'),
      code: z.string().min(1).describe('Unique code within node'),
      name: z.string().min(1).describe('Display name'),
      type: z
        .enum([
          'storage',
          'receiving',
          'shipping',
          'picking',
          'packing',
          'transit',
          'returns',
          'quality_hold',
          'damaged',
          'internal',
          'production',
          'view',
          'vendor',
          'customer',
          'scrap',
          'inventory_loss',
        ])
        .default('storage'),
      barcode: z.string().optional(),
      coordinates: coordinatesSchema.optional(),
      maxWeight: z.number().optional().describe('Max weight in grams'),
      maxVolume: z.number().optional().describe('Max volume in cm³'),
      sortOrder: z.number().optional(),
      allowReservations: z.boolean().optional(),
      allowNegativeStock: z.boolean().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
    response: { 201: successData(locationEntity) },
  },
  bulkCreate: {
    body: z.object({
      nodeId: z.string().describe('Warehouse node ID'),
      locations: z
        .array(
          z.object({
            code: z.string(),
            name: z.string(),
            type: z.string().default('storage'),
            parentLocationId: z.string().optional(),
            coordinates: coordinatesSchema.optional(),
            maxWeight: z.number().optional(),
            maxVolume: z.number().optional(),
            sortOrder: z.number().optional(),
            barcode: z.string().optional(),
          }),
        )
        .min(1)
        .describe('Locations to create'),
    }),
    response: { 201: successData(z.object({ created: z.number(), locations: z.array(locationEntity) })) },
  },
  layout: {
    querystring: z.object({
      nodeId: z.string().describe('Warehouse node ID'),
    }),
  },
  update: {
    params: idParam,
    body: z.object({
      name: z.string().optional(),
      status: z.enum(['active', 'inactive']).optional(),
      barcode: z.string().optional(),
      coordinates: coordinatesSchema.optional(),
      maxWeight: z.number().optional(),
      maxVolume: z.number().optional(),
      sortOrder: z.number().optional(),
      allowReservations: z.boolean().optional(),
      allowNegativeStock: z.boolean().optional(),
      parentLocationId: z.string().nullable().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  },
};

// ── Audit ──

export const auditSchemas = {
  create: {
    body: z.object({
      countType: z.enum(['full', 'cycle', 'spot']).describe('Audit type'),
      scope: z
        .object({
          nodeId: z.string().optional().describe('Warehouse to audit'),
          locationId: z.string().optional().describe('Specific location'),
          skuRefs: z.array(z.string()).optional().describe('Specific SKUs'),
        })
        .optional(),
      freezePolicy: z.enum(['hard_freeze', 'soft_freeze', 'none']).optional(),
    }),
  },
  submitLines: {
    params: idParam,
    body: z.object({
      lines: z
        .array(
          z.object({
            skuRef: z.string(),
            locationId: z.string(),
            lotId: z.string().optional(),
            serialCode: z.string().optional(),
            countedQuantity: z.number().min(0),
            varianceReason: z.string().optional(),
          }),
        )
        .min(1),
    }),
  },
  reconcile: {
    params: idParam,
    body: z.object({
      action: z.literal('reconcile'),
      autoApproveThreshold: z.number().min(0).optional().describe('Auto-approve variances within this qty'),
    }),
  },
};
