/**
 * Advanced Warehouse Schemas (Zod v4)
 *
 * Schemas for Flow-native features gated by FLOW_MODE:
 * - Lot/Serial tracking (standard+)
 * - Package management (standard+)
 * - Procurement orders (standard+)
 * - Replenishment rules (standard+)
 * - Cost layers & valuation (standard+)
 * - Traceability (enterprise)
 * - Reports (enterprise)
 */
import { z } from 'zod';

// ── Shared ──

const successData = <T extends z.ZodType>(schema: T) => z.object({ success: z.literal(true), data: schema });

const listData = <T extends z.ZodType>(schema: T) =>
  z.object({ success: z.literal(true), data: z.array(schema), total: z.number() });

const idParam = z.object({ id: z.string() });

// ── Lot/Serial Tracking ──

const lotEntity = z.object({
  _id: z.string(),
  organizationId: z.string(),
  skuRef: z.string(),
  trackingType: z.enum(['lot', 'serial']),
  lotCode: z.string().optional(),
  serialCode: z.string().optional(),
  status: z.enum(['active', 'recalled', 'expired']),
  manufacturedAt: z.string().datetime().optional(),
  receivedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  vendorBatchRef: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const lotSchemas = {
  create: {
    body: z.object({
      skuRef: z.string().describe('SKU reference'),
      trackingType: z.enum(['lot', 'serial']).describe('Lot = batch, serial = individual unit'),
      lotCode: z.string().optional().describe('Batch/lot code (required for lot type)'),
      serialCode: z.string().optional().describe('Serial number (required for serial type)'),
      manufacturedAt: z.string().datetime().optional(),
      receivedAt: z.string().datetime().optional(),
      expiresAt: z.string().datetime().optional(),
      vendorBatchRef: z.string().optional().describe('Vendor batch reference'),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
    response: { 201: successData(lotEntity) },
  },
  list: {
    querystring: z.object({
      skuRef: z.string().optional().describe('Filter by SKU'),
      trackingType: z.enum(['lot', 'serial']).optional(),
      status: z.enum(['active', 'recalled', 'expired']).optional(),
      limit: z.coerce.number().min(1).max(100).optional(),
    }),
    response: { 200: listData(lotEntity) },
  },
  update: {
    params: idParam,
    body: z.object({
      status: z.enum(['active', 'recalled', 'expired']).optional(),
      expiresAt: z.string().datetime().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  },
};

// ── Package Management ──

const packageEntity = z.object({
  _id: z.string(),
  organizationId: z.string(),
  barcode: z.string(),
  parentPackageId: z.string().optional(),
  locationId: z.string().optional(),
  packageType: z.enum(['reusable', 'disposable']).optional(),
  baseWeight: z.number().optional(),
  maxWeight: z.number().optional(),
  status: z.string().optional(),
});

export const packageSchemas = {
  create: {
    body: z.object({
      barcode: z.string().optional().describe('Barcode (auto-generated if omitted)'),
      locationId: z.string().optional(),
      packageType: z.enum(['reusable', 'disposable']).default('disposable'),
      baseWeight: z.number().optional().describe('Empty weight in grams'),
      maxWeight: z.number().optional().describe('Max weight in grams'),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
    response: { 201: successData(packageEntity) },
  },
  list: {
    querystring: z.object({
      locationId: z.string().optional(),
      parentPackageId: z.string().optional(),
      limit: z.coerce.number().min(1).max(100).optional(),
    }),
  },
  nest: {
    params: idParam,
    body: z.object({
      childPackageId: z.string().describe('Package to nest inside this one'),
    }),
  },
  contents: {
    params: idParam,
  },
};

// ── Procurement Orders ──

const procurementItemSchema = z.object({
  skuRef: z.string().describe('SKU reference'),
  quantity: z.number().min(1),
  unitCost: z.number().min(0).optional(),
  expectedDate: z.string().datetime().optional(),
  lotCode: z.string().optional().describe('Lot code to assign on receipt'),
});

const procurementEntity = z.object({
  _id: z.string(),
  organizationId: z.string(),
  documentNumber: z.string(),
  vendorRef: z.string().optional(),
  status: z.enum(['draft', 'approved', 'ordered', 'partially_received', 'received', 'cancelled']),
  items: z.array(
    z.object({
      skuRef: z.string(),
      quantity: z.number(),
      quantityReceived: z.number().optional(),
      unitCost: z.number().optional(),
    }),
  ),
  destinationNodeId: z.string().optional(),
  destinationLocationId: z.string().optional(),
});

export const procurementSchemas = {
  create: {
    body: z.object({
      vendorRef: z.string().optional().describe('Vendor/supplier reference'),
      items: z.array(procurementItemSchema).min(1),
      destinationNodeId: z.string().optional().describe('Target warehouse node'),
      destinationLocationId: z.string().optional().describe('Target location (defaults to receiving)'),
      notes: z.string().optional(),
    }),
    response: { 201: successData(procurementEntity) },
  },
  list: {
    querystring: z.object({
      status: z.string().optional(),
      vendorRef: z.string().optional(),
      limit: z.coerce.number().min(1).max(100).optional(),
    }),
    response: { 200: listData(procurementEntity) },
  },
  receive: {
    params: idParam,
    body: z.object({
      items: z
        .array(
          z.object({
            skuRef: z.string(),
            quantity: z.number().min(1).describe('Quantity received'),
            lotCode: z.string().optional(),
          }),
        )
        .min(1)
        .describe('Items being received'),
      locationId: z.string().optional().describe('Receive location override'),
    }),
  },
  action: {
    params: idParam,
    body: z.object({
      action: z.enum(['approve', 'cancel']),
    }),
  },
};

// ── Replenishment Rules ──

const ruleEntity = z.object({
  _id: z.string(),
  organizationId: z.string(),
  skuRef: z.string(),
  scope: z.enum(['node', 'location']),
  scopeId: z.string(),
  reorderPoint: z.number(),
  targetLevel: z.number(),
  minOrderQty: z.number().optional(),
  maxOrderQty: z.number().optional(),
  multipleOf: z.number().optional(),
  leadTimeDays: z.number().optional(),
  safetyStock: z.number().optional(),
  preferredSourceId: z.string().optional(),
  isActive: z.boolean(),
});

export const replenishmentSchemas = {
  create: {
    body: z.object({
      skuRef: z.string().describe('SKU to monitor'),
      scope: z.enum(['node', 'location']).describe('Rule applies to node or location'),
      scopeId: z.string().describe('Node or location ID'),
      reorderPoint: z.number().min(0).describe('Trigger replenishment below this level'),
      targetLevel: z.number().min(1).describe('Order up to this level'),
      minOrderQty: z.number().optional(),
      maxOrderQty: z.number().optional(),
      multipleOf: z.number().optional().describe('Round order qty to multiple of this'),
      leadTimeDays: z.number().optional(),
      safetyStock: z.number().optional(),
      preferredSourceId: z.string().optional().describe('Preferred vendor/source node'),
    }),
    response: { 201: successData(ruleEntity) },
  },
  list: {
    querystring: z.object({
      skuRef: z.string().optional(),
      scopeId: z.string().optional(),
      isActive: z.coerce.boolean().optional(),
      limit: z.coerce.number().min(1).max(100).optional(),
    }),
    response: { 200: listData(ruleEntity) },
  },
  update: {
    params: idParam,
    body: z.object({
      reorderPoint: z.number().min(0).optional(),
      targetLevel: z.number().min(1).optional(),
      minOrderQty: z.number().optional(),
      maxOrderQty: z.number().optional(),
      multipleOf: z.number().optional(),
      leadTimeDays: z.number().optional(),
      safetyStock: z.number().optional(),
      preferredSourceId: z.string().optional(),
      isActive: z.boolean().optional(),
    }),
  },
  evaluate: {
    body: z.object({
      skuRef: z.string().optional().describe('Evaluate specific SKU (or all if omitted)'),
      nodeId: z.string().optional().describe('Evaluate for specific node'),
      dryRun: z.boolean().optional().describe('Preview triggers without creating orders'),
    }),
  },
};

// ── Cost Layers & Valuation ──

export const costSchemas = {
  valuation: {
    querystring: z.object({
      skuRef: z.string().optional().describe('Filter by SKU'),
      locationId: z.string().optional().describe('Filter by location'),
      nodeId: z.string().optional().describe('Filter by node'),
    }),
  },
  layers: {
    querystring: z.object({
      skuRef: z.string().describe('SKU reference'),
      locationId: z.string().optional(),
      limit: z.coerce.number().min(1).max(100).optional(),
    }),
  },
};

// ── Traceability ──

export const traceSchemas = {
  traceLot: {
    querystring: z.object({
      lotId: z.string().describe('Lot ID to trace'),
    }),
  },
  traceSerial: {
    querystring: z.object({
      serialCode: z.string().describe('Serial code to trace'),
      skuRef: z.string().describe('SKU reference'),
    }),
  },
  recall: {
    body: z.object({
      lotId: z.string().describe('Lot ID to recall'),
    }),
  },
};

// ── Reports ──

export const reportSchemas = {
  aging: {
    querystring: z.object({
      nodeId: z.string().optional(),
      skuRef: z.string().optional(),
      buckets: z.string().optional().describe('Comma-separated day boundaries (default: 30,60,90)'),
    }),
  },
  turnover: {
    querystring: z.object({
      nodeId: z.string().optional(),
      skuRef: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    }),
  },
  availability: {
    querystring: z.object({
      nodeId: z.string().optional(),
      skuRefs: z.string().optional().describe('Comma-separated SKU references'),
    }),
  },
  health: {
    querystring: z.object({
      nodeId: z.string().optional(),
    }),
  },
};
