/**
 * Warehouse Location schemas — Zod v4.
 *
 * A location is a physical bin / zone / aisle inside a Node. Supports
 * hierarchical nesting (parentLocationId) and coordinates for the
 * warehouse-designer UI.
 */
import { z } from 'zod';

const idParam = z.object({ id: z.string() });

const successData = <T extends z.ZodType>(schema: T) => z.object({ success: z.literal(true), data: schema });

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
  allowReservations: z.boolean().optional(),
  allowNegativeStock: z.boolean().optional(),
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
