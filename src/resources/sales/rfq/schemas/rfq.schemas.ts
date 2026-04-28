import { z } from 'zod';

const moneySchema = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().min(3).max(3),
});

const lineItemSchema = z.object({
  lineId: z.string().optional(),
  skuRef: z.string().optional(),
  description: z.string().min(1),
  quantity: z.number().positive(),
  unit: z.string().optional(),
  targetUnitCost: moneySchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const invitedVendorSchema = z.object({
  vendorId: z.string().min(1),
  vendorName: z.string().optional(),
  vendorEmail: z.email().optional(),
});

export const createRfqSchema = {
  body: z.object({
    lineItems: z.array(lineItemSchema).min(1),
    invitedVendors: z.array(invitedVendorSchema).min(1),
    validUntil: z.iso.datetime().optional(),
    notes: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
};

const vendorQuoteLineSchema = z.object({
  lineId: z.string().min(1),
  unitPrice: moneySchema,
  quantity: z.number().nonnegative(),
  notes: z.string().optional(),
});

export const submitResponseSchema = z.object({
  vendorId: z.string().min(1),
  lines: z.array(vendorQuoteLineSchema).min(1),
  totalPrice: moneySchema,
  leadTimeDays: z.number().int().nonnegative(),
  terms: z.string().optional(),
  validUntil: z.iso.datetime().optional(),
  notes: z.string().optional(),
});

export const awardRfqSchema = z.object({
  vendorId: z.string().min(1),
  rationale: z.string().optional(),
});

export const cancelRfqSchema = z.object({
  reason: z.string().optional(),
});
