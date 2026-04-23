/**
 * Stock reservation schemas — Zod v4.
 *
 * Reservations lock stock against a specific owner (order, cart,
 * move_group). Two modes: soft (advisory) and hard (strict lock).
 */
import { z } from 'zod';

const idParam = z.object({ id: z.string().describe('Resource ID') });

const successEnvelope = (dataSchema: z.ZodTypeAny) => z.object({ success: z.literal(true), data: dataSchema });

const reservationResult = z.object({
  _id: z.string(),
  organizationId: z.string(),
  reservationType: z.enum(['soft', 'hard']),
  ownerType: z.string(),
  ownerId: z.string(),
  skuRef: z.string(),
  locationId: z.string(),
  quantity: z.number(),
  quantityConsumed: z.number().optional(),
  status: z.string(),
  expiresAt: z.string().datetime().optional(),
  createdAt: z.string().datetime().optional(),
});

export const reservationSchemas = {
  create: {
    body: z.object({
      reservationType: z.enum(['soft', 'hard']).describe('Soft = advisory, hard = locked'),
      ownerType: z.string().describe('Owner entity type (e.g. order, cart, move_group)'),
      ownerId: z.string().describe('Owner entity ID'),
      skuRef: z.string().describe('SKU reference'),
      locationId: z.string().optional().describe('Location ID (defaults to main)'),
      quantity: z.number().min(1).describe('Quantity to reserve'),
      expiresAt: z.string().datetime().optional().describe('Reservation expiry (ISO 8601)'),
      branchId: z.string().optional().describe('Organization/branch ID'),
    }),
    response: { 201: successEnvelope(reservationResult) },
  },
  release: {
    params: idParam,
    response: { 200: successEnvelope(reservationResult) },
  },
  consume: {
    params: idParam,
    body: z.object({
      quantity: z.number().min(1).describe('Quantity to consume from reservation'),
    }),
    response: { 200: successEnvelope(reservationResult) },
  },
};
