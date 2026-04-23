/**
 * Scrap (write-off) schemas — Zod v4.
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

const scrapReason = z.enum([
  'damaged',
  'expired',
  'quality_fail',
  'shrinkage',
  'theft',
  'sample',
  'obsolete',
  'recall',
  'other',
]);

const scrapStatus = z.enum(['draft', 'pending_approval', 'approved', 'rejected', 'executed', 'cancelled']);

const scrapEntity = z.object({
  _id: z.string(),
  organizationId: z.string(),
  scrapNumber: z.string(),
  status: scrapStatus,
  skuRef: z.string(),
  locationId: z.string(),
  quantity: z.number(),
  lotId: z.string().optional(),
  serialCode: z.string().optional(),
  packageId: z.string().optional(),
  reason: scrapReason,
  note: z.string().optional(),
  sourceRef: externalRef.optional(),
  valueAtDraft: money.optional(),
  replenishmentRequested: z.boolean().optional(),
  moveId: z.string().optional(),
  moveGroupId: z.string().optional(),
  executedAt: z.iso.datetime().optional(),
  executedBy: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const scrapSchemas = {
  list: {
    querystring: z.object({
      status: scrapStatus.optional(),
      skuRef: z.string().optional(),
      locationId: z.string().optional(),
      limit: z.coerce.number().min(1).max(200).optional(),
    }),
    response: {
      200: z.object({
        success: z.literal(true),
        data: z.array(scrapEntity),
        total: z.number(),
      }),
    },
  },
  get: { params: idParam, response: { 200: successData(scrapEntity) } },
  create: {
    body: z.object({
      skuRef: z.string(),
      locationId: z.string(),
      quantity: z.number().positive(),
      reason: scrapReason,
      lotId: z.string().optional(),
      serialCode: z.string().optional(),
      packageId: z.string().optional(),
      note: z.string().optional(),
      sourceRef: externalRef.optional(),
      valueAtDraft: money.optional(),
      replenishmentRequested: z.boolean().optional(),
    }),
    response: { 201: successData(scrapEntity) },
  },
  action: {
    params: idParam,
    body: z.object({
      action: z.enum(['approve', 'reject', 'cancel', 'execute']),
      reason: z.string().optional(),
      /** Required when `action=approve` on a scrap with an approvals chain. */
      decision: z
        .object({
          stepId: z.string(),
          approverId: z.string(),
          decision: z.enum(['approved', 'rejected']),
          note: z.string().optional(),
        })
        .optional(),
    }),
  },
};
