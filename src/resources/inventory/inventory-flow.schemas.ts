/**
 * Flow-Native Inventory Schemas (Zod v4)
 *
 * Request/response validation + auto OpenAPI doc generation for
 * availability, reservation, and scan endpoints.
 *
 * Arc auto-converts Zod schemas to JSON Schema via z.toJSONSchema().
 */
import { z } from 'zod';

// ── Shared ──

const idParam = z.object({ id: z.string().describe('Resource ID') });

// Arc 2.13 emits flat payloads (no envelope wrap). The "envelope" helper
// now just passes the data schema through — the wire IS the data.
const successEnvelope = (dataSchema: z.ZodTypeAny) => dataSchema;

const _errorEnvelope = z.object({
  success: z.literal(false),
  message: z.string().optional(),
  error: z.string().optional(),
});

// ── Availability ──

const availabilityResult = z.object({
  quantityOnHand: z.number(),
  quantityReserved: z.number(),
  quantityAvailable: z.number(),
  quantityIncoming: z.number(),
  quantityOutgoing: z.number(),
});

export const availabilitySchemas = {
  get: {
    querystring: z.object({
      skuRef: z.string().optional().describe('Filter by SKU reference'),
      nodeId: z.string().optional().describe('Filter by warehouse node ID'),
      locationId: z.string().optional().describe('Filter by location ID'),
      branchId: z.string().optional().describe('Organization/branch ID (overrides auth context)'),
    }),
    response: { 200: successEnvelope(availabilityResult) },
  },
  check: {
    body: z.object({
      items: z
        .array(
          z.object({
            skuRef: z.string().describe('SKU reference'),
            quantity: z.number().min(1).describe('Required quantity'),
          }),
        )
        .min(1)
        .describe('Items to check availability for'),
      nodeId: z
        .string()
        .optional()
        .describe('Narrow to a specific warehouse node. Omit to aggregate across the branch.'),
      branchId: z.string().optional().describe('Organization/branch ID'),
    }),
    response: {
      200: successEnvelope(
        z.object({
          // Matches @classytic/flow's AvailabilityCheckResult verbatim —
          // no translation, single vocabulary end-to-end.
          allFulfilled: z.boolean(),
          items: z.array(
            z.object({
              skuRef: z.string(),
              requested: z.number(),
              available: z.number(),
              fulfilled: z.boolean(),
            }),
          ),
        }),
      ),
    },
  },
};

// ── Reservation ──

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

// ── Scan ──

const scanResult = z.object({
  token: z.string().describe('Original scanned token'),
  resolvedType: z
    .enum(['sku', 'lot', 'serial', 'location', 'package', 'document', 'unknown'])
    .describe('Resolved entity type'),
  resolvedId: z.string().nullable().describe('Resolved entity ID, or null when unknown'),
  resolvedEntity: z
    .record(z.string(), z.unknown())
    .nullable()
    .describe('Resolved entity details, or null when unknown'),
  action: z.enum(['receive', 'pick', 'move', 'count', 'verify']).optional(),
});

export const scanSchemas = {
  resolve: {
    body: z.object({
      token: z.string().min(1).describe('Barcode, QR code, RFID, or SKU token to resolve'),
    }),
    response: { 200: successEnvelope(scanResult) },
  },
};

// ── Adjustments ──

export const adjustmentSchemaZod = {
  body: z.object({
    productId: z.string().optional().describe('Product ID (single item)'),
    variantSku: z.string().optional().describe('Variant SKU'),
    quantity: z.number().optional().describe('Target quantity or adjustment amount'),
    mode: z.enum(['set', 'add', 'remove']).default('set').describe('set: absolute, add: increase, remove: decrease'),
    reason: z.string().optional().describe('Short reason code / category (e.g. "recount")'),
    notes: z.string().optional().describe('Free-form notes persisted on the move group for audit'),
    locationId: z
      .string()
      .optional()
      .describe('Target location ID (Location document _id). Defaults to branch default stock location.'),
    adjustments: z
      .array(
        z.object({
          productId: z.string(),
          variantSku: z.string().optional(),
          quantity: z.number(),
          mode: z.enum(['set', 'add', 'remove']).optional(),
          reason: z.string().optional(),
          notes: z.string().optional(),
          locationId: z.string().optional().describe('Per-item target location ID (overrides top-level)'),
        }),
      )
      .optional()
      .describe('Bulk adjustments (alternative to single item)'),
    branchId: z.string().optional().describe('Branch ID (defaults to main)'),
    lostAmount: z.number().min(0).optional().describe('Create expense transaction for this amount'),
    transactionData: z
      .object({
        paymentMethod: z.enum(['cash', 'bkash', 'nagad', 'rocket', 'bank_transfer']).default('cash'),
        reference: z.string().optional(),
      })
      .optional()
      .describe('Transaction details (only if lostAmount provided)'),
  }),
  response: {
    // Arc 2.13 emits raw payloads (no envelope wrap). The single-item
    // adjustment handler spreads the result at the top level, so the
    // wire is the result fields directly + `message` + `transaction`,
    // not a `{ data: ... }` wrapper. Use `passthrough()` to admit the
    // dynamic result-shape fields without enumerating each.
    200: z
      .object({
        message: z.string().optional(),
        transaction: z
          .object({
            _id: z.any(),
            amount: z.number(),
            category: z.string(),
          })
          .nullable()
          .optional(),
      })
      .passthrough(),
  },
};

// ── Movements ──

export const movementSchemas = {
  list: {
    querystring: z.object({
      productId: z.string().optional().describe('Filter by product ID'),
      branchId: z.string().optional().describe('Filter by branch'),
      type: z.string().optional().describe('Filter by movement type'),
      startDate: z.string().optional().describe('Start date (ISO 8601)'),
      endDate: z.string().optional().describe('End date (ISO 8601)'),
      page: z.coerce.number().min(1).optional().describe('Page number'),
      limit: z.coerce.number().min(1).max(100).optional().describe('Items per page'),
      sort: z.string().optional().describe('Sort field'),
    }),
  },
};
