/**
 * POS Schemas — Zod v4. Arc auto-converts via `z.toJSONSchema()` at
 * registration (Fastify validation + OpenAPI).
 *
 * 6 endpoints (catalog browse, lookup, create order, receipt). Stock
 * adjustment lives in the inventory module — POS never adjusts stock
 * directly.
 */
import { z } from 'zod';

// ============================================
// CATALOG SCHEMAS
// ============================================

// `.loose()` lets QueryParser-driven filters (parentCategory, stockStatus,
// `status[eq]=active` bracket syntax, ad-hoc bracket operators) reach the
// controller. Without it AJV strips/rejects unknown keys before the handler
// gets to call QueryParser.
export const posProductsSchema = {
  querystring: z.object({
    branchId: z.string().optional(),
    category: z.string().optional(),
    search: z.string().optional(),
    inStockOnly: z.coerce.boolean().optional(),
    lowStockOnly: z.coerce.boolean().optional(),
    page: z.coerce.number().optional(),
    limit: z.coerce.number().optional(),
    sort: z.string().optional(),
  }).loose(),
};

export const lookupSchema = {
  querystring: z.object({
    code: z.string(),
    branchId: z.string().optional(),
  }),
};

// ============================================
// ORDER SCHEMAS
// ============================================

// `productId` and `branchId`/`customer.id` accept either a string or an
// object (legacy POS clients sometimes send the populated object). Zod's
// `z.union([z.string(), z.object({}).passthrough()])` mirrors the original
// `anyOf: [{ type: 'string' }, { type: 'object' }]`.
const stringOrObject = z.union([z.string(), z.object({}).passthrough()]);

const orderItem = z.object({
  productId: stringOrObject,
  variantSku: z.string().optional(),
  quantity: z.number().min(1),
  price: z.number().optional(),
});

const customerInput = z.object({
  id: stringOrObject.optional(),
  name: z.string().optional(),
  phone: z.string().optional(),
});

const paymentInput = z.object({
  method: z.enum(['cash', 'bkash', 'nagad', 'rocket', 'bank_transfer', 'card']),
  amount: z.number().min(0),
  reference: z.string().optional(),
  // Method-specific details (walletNumber, bankName, etc.) — passthrough so
  // bkash/nagad/bank-transfer payloads carry their wallet fields through.
  details: z.object({}).passthrough().optional(),
});

// `.loose()` keeps BD routing fields (areaId/zoneId/division/country) and
// the `providerAreaIds` bag (pathao.cityId/zoneId, redx.areaId, ...) flowing
// through to `toFulfillmentAddress` instead of getting stripped by AJV
// strict-mode. The fulfillment address schema in @classytic/order accepts
// the extras under `providerRefs`, so logistics adapters can read
// authoritative ids without name-matching.
const deliveryAddress = z.object({
  recipientName: z.string().optional(),
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  areaName: z.string().optional(),
  city: z.string().optional(),
  recipientPhone: z.string().optional(),
  postalCode: z.string().optional(),
}).loose();

export const createOrderSchema = {
  body: z.object({
    items: z.array(orderItem).min(1),
    branchId: stringOrObject.optional(),
    branchSlug: z.string().optional(),
    customer: customerInput.optional(),
    payments: z.array(paymentInput).optional(),
    discount: z.number().optional(),
    deliveryMethod: z.enum(['pickup', 'delivery']).optional(),
    deliveryPrice: z.number().optional(),
    deliveryAreaId: z.number().optional(),
    deliveryAddress: deliveryAddress.optional(),
    notes: z.string().optional(),
    terminalId: z.string().optional(),
    idempotencyKey: z.string().max(200).optional(),
    membershipCardId: z.string().max(50).optional(),
    pointsToRedeem: z.number().int().min(0).optional(),
  }),
};

export const receiptSchema = {
  params: z.object({
    orderId: z.string(),
  }),
};

// Note: stock-adjustment schemas live in the inventory module — POS never
// adjusts stock directly. (See inventory-management.plugin.ts.)

export default {
  posProductsSchema,
  lookupSchema,
  createOrderSchema,
  receiptSchema,
};
