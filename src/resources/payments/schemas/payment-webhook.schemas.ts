/**
 * Payment Webhook Schemas — Zod v4. Arc auto-converts via
 * `z.toJSONSchema()` at registration (Fastify validation + OpenAPI).
 */
import { z } from 'zod';

const objectIdPattern = /^[0-9a-fA-F]{24}$/;

export const manualVerificationBody = z.object({
  transactionId: z.string().regex(objectIdPattern),
  notes: z.string().max(500).optional(),
});

export const manualRejectionBody = z.object({
  transactionId: z.string().regex(objectIdPattern),
  reason: z.string().min(3).max(500),
});

export const providerParams = z.object({
  provider: z.string(),
});

export default {
  manualVerificationBody,
  manualRejectionBody,
  providerParams,
};
