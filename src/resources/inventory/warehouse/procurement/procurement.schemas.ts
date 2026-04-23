/**
 * Procurement order schemas — Zod v4.
 *
 * Field names mirror Flow's ProcurementOrder entity so fast-json-stringify
 * never rejects response payloads.
 */
import { z } from 'zod';

const idParam = z.object({ id: z.string() });

const successData = <T extends z.ZodType>(schema: T) => z.object({ success: z.literal(true), data: schema });

const listData = <T extends z.ZodType>(schema: T) =>
  z.object({ success: z.literal(true), data: z.array(schema), total: z.number() });

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
  orderNumber: z.string(),
  vendorRef: z.string().optional(),
  status: z.enum(['draft', 'approved', 'ordered', 'partially_received', 'received', 'cancelled']),
  items: z.array(
    z.object({
      skuRef: z.string(),
      quantity: z.number(),
      quantityReceived: z.number(),
      quantityInvoiced: z.number(),
      unitCost: z.number(),
      sourceUnitCost: z.number().optional(),
      expectedAt: z.string().datetime().optional(),
    }),
  ),
  destinationNodeId: z.string().optional(),
  destinationLocationId: z.string().optional(),
  fx: z.unknown().optional(),
  expectedAt: z.string().datetime().optional(),
  receivedAt: z.string().datetime().optional(),
  sourceDemandRefs: z.array(z.string()).optional(),
  createdBy: z.string().optional(),
  modifiedBy: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
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
      lines: z
        .array(
          z.object({
            skuRef: z.string(),
            quantityReceived: z.number().min(1).describe('Quantity physically received'),
            lotCode: z.string().optional(),
            serialCode: z.string().optional(),
            expiresAt: z.string().datetime().optional(),
            unitCost: z.number().optional(),
          }),
        )
        .min(1)
        .describe('Line-by-line receipts'),
      receivedAt: z.string().datetime().optional(),
    }),
  },
  action: {
    params: idParam,
    body: z.object({
      action: z.enum(['approve', 'cancel']),
    }),
  },
};
