/**
 * Landed-cost schemas — Zod v4.
 */
import { z } from 'zod';

const successData = <T extends z.ZodType>(schema: T) => schema;

const idParam = z.object({ id: z.string() });

const allocationMethod = z.enum(['by_value', 'by_quantity', 'by_weight', 'by_volume', 'equal']);

const costLine = z.object({
  code: z.string(),
  amount: z.number().nonnegative(),
  method: allocationMethod,
  note: z.string().optional(),
  sourceAmount: z.number().optional(),
  sourceCurrency: z.string().optional(),
  fxRate: z.number().optional(),
  fxSnapshotAt: z.iso.datetime().optional(),
  fxSource: z.string().optional(),
});

const landedCostEntity = z.object({
  _id: z.string(),
  organizationId: z.string(),
  ref: z.string().optional(),
  vendorBillRef: z.string().optional(),
  baseCurrency: z.string().optional(),
  pickingIds: z.array(z.string()),
  costLines: z.array(costLine),
  allocations: z.array(
    z.object({
      skuRef: z.string(),
      costLineCode: z.string(),
      method: allocationMethod,
      quantity: z.number(),
      allocatedCost: z.number(),
      costLayerRef: z.string().optional(),
    }),
  ),
  status: z.enum(['draft', 'applied', 'reversed']),
  appliedAt: z.iso.datetime().optional(),
  appliedBy: z.string().optional(),
  reversedAt: z.iso.datetime().optional(),
  reversedBy: z.string().optional(),
  reversalReason: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const landedCostSchemas = {
  list: {
    querystring: z.object({
      status: z.enum(['draft', 'applied', 'reversed']).optional(),
      vendorBillRef: z.string().optional(),
      limit: z.coerce.number().min(1).max(200).optional(),
    }),
    response: {
      200: z.object({
        data: z.array(landedCostEntity),
        total: z.number(),
      }),
    },
  },
  get: { params: idParam, response: { 200: successData(landedCostEntity) } },
  create: {
    body: z.object({
      ref: z.string().optional(),
      vendorBillRef: z.string().optional(),
      baseCurrency: z.string().optional(),
      pickingIds: z.array(z.string()).default([]),
      costLines: z.array(costLine).min(1),
    }),
    response: { 201: successData(landedCostEntity) },
  },
  update: {
    params: idParam,
    body: z.object({
      ref: z.string().optional(),
      vendorBillRef: z.string().optional(),
      baseCurrency: z.string().optional(),
      pickingIds: z.array(z.string()).optional(),
      costLines: z.array(costLine).optional(),
    }),
  },
  apply: {
    params: idParam,
    body: z.object({
      items: z
        .array(
          z.object({
            skuRef: z.string(),
            quantity: z.number().positive(),
            value: z.number().nonnegative(),
            weight: z.number().optional(),
            volume: z.number().optional(),
          }),
        )
        .min(1),
    }),
  },
  reverse: {
    params: idParam,
    body: z.object({
      reason: z.string().optional(),
    }),
  },
};
