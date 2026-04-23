/**
 * Customer return-order (RMA) schemas — Zod v4.
 */
import { z } from 'zod';

const successData = <T extends z.ZodType>(schema: T) => z.object({ success: z.literal(true), data: schema });

const idParam = z.object({ id: z.string() });

const externalRef = z.object({
  sourceId: z.string(),
  sourceModel: z.string(),
});

const money = z.object({
  amount: z.number(),
  currency: z.string(),
});

const returnReason = z.enum([
  'defective',
  'damaged_in_transit',
  'wrong_item',
  'not_as_described',
  'changed_mind',
  'late_delivery',
  'warranty',
  'recall',
  'other',
]);

const returnDisposition = z.enum(['restock', 'scrap', 'rework', 'return_to_vendor']);

const returnStatus = z.enum(['draft', 'confirmed', 'received', 'inspected', 'dispatched', 'closed', 'cancelled']);

const returnLineStatus = z.enum(['pending', 'received', 'inspected', 'dispatched', 'cancelled']);

const returnLine = z.object({
  lineId: z.string(),
  skuRef: z.string(),
  quantityRequested: z.number(),
  quantityReceived: z.number().optional(),
  disposition: returnDisposition.optional(),
  scrapReason: z.string().optional(),
  lotId: z.string().optional(),
  serialCode: z.string().optional(),
  restockLocationId: z.string().optional(),
  moveId: z.string().optional(),
  scrapId: z.string().optional(),
  notes: z.string().optional(),
  status: returnLineStatus,
});

const returnEntity = z.object({
  _id: z.string(),
  organizationId: z.string(),
  returnNumber: z.string(),
  status: returnStatus,
  customerRef: externalRef,
  linkedOrderRef: externalRef.optional(),
  reason: returnReason,
  note: z.string().optional(),
  returnLocationId: z.string(),
  items: z.array(returnLine),
  refund: money.optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const returnSchemas = {
  list: {
    querystring: z.object({
      status: returnStatus.optional(),
      'customerRef.sourceId': z.string().optional(),
      'linkedOrderRef.sourceId': z.string().optional(),
      limit: z.coerce.number().min(1).max(200).optional(),
    }),
    response: {
      200: z.object({
        success: z.literal(true),
        data: z.array(returnEntity),
        total: z.number(),
      }),
    },
  },
  get: { params: idParam, response: { 200: successData(returnEntity) } },
  create: {
    body: z.object({
      customerRef: externalRef,
      linkedOrderRef: externalRef.optional(),
      reason: returnReason,
      note: z.string().optional(),
      returnLocationId: z.string(),
      items: z
        .array(
          z.object({
            skuRef: z.string(),
            quantityRequested: z.number().positive(),
            lotId: z.string().optional(),
            serialCode: z.string().optional(),
            notes: z.string().optional(),
          }),
        )
        .min(1),
      refund: money.optional(),
    }),
    response: { 201: successData(returnEntity) },
  },
  receive: {
    params: idParam,
    body: z.object({
      lines: z
        .array(
          z.object({
            lineId: z.string(),
            quantityReceived: z.number().positive(),
            lotId: z.string().optional(),
            serialCode: z.string().optional(),
          }),
        )
        .min(1),
    }),
  },
  inspect: {
    params: idParam,
    body: z.object({
      decisions: z
        .array(
          z.object({
            lineId: z.string(),
            disposition: returnDisposition,
            scrapReason: z.string().optional(),
            restockLocationId: z.string().optional(),
            notes: z.string().optional(),
          }),
        )
        .min(1),
    }),
  },
  action: {
    params: idParam,
    body: z.object({
      action: z.enum(['confirm', 'dispatch', 'close', 'cancel']),
      reason: z.string().optional(),
    }),
  },
};
