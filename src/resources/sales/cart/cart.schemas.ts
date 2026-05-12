/**
 * Cart route schemas — zod v4. Arc auto-converts to JSON Schema at
 * registration time via `convertRouteSchema()`. No manual conversion.
 */
import { z } from 'zod';

/**
 * Optional client-supplied display snapshot — storefronts that already have
 * the product (PDP add-to-cart, POS scan → cart) can send the denormalized
 * fields so the backend skips a catalog round-trip. Shape matches
 * @classytic/cart's LineDisplay VO; price drift is still caught at checkout
 * via pricingHash, so letting the client provide cosmetic fields is safe.
 */
const moneySchema = z.object({
  amount: z.number().int(),
  currency: z.string().min(1),
});

const displaySchema = z
  .object({
    name: z.string().optional(),
    imageUrl: z.string().optional(),
    slug: z.string().optional(),
    variantLabel: z.string().optional(),
    compareAtPrice: moneySchema.nullable().optional(),
    // ISO string — the controller converts to Date before handing to the
    // repository. Avoid z.coerce.date() here because arc's zod→JSON-Schema
    // converter doesn't model coercion, which can bypass body validation.
    capturedAt: z.string().optional(),
  })
  .optional();

export const addItemSchema = {
  body: z.object({
    productId: z.string().min(1),
    variantSku: z.string().nullable().optional(),
    quantity: z.number().int().min(1),
    display: displaySchema,
  }),
  // Retry safety is handled by arc's idempotencyPlugin (registered globally
  // in register-infra-plugins.ts): clients pass the `idempotency-key` HTTP
  // header and arc caches the response for 24h. No body-level dedup needed.
};

export const updateItemSchema = {
  params: z.object({ itemId: z.string().min(1) }),
  body: z.object({ quantity: z.number().int().min(0) }),
};

export const removeItemSchema = {
  params: z.object({ itemId: z.string().min(1) }),
};

export const startCheckoutSchema = {
  body: z.object({
    expectedPricingHash: z.string().nullable().optional(),
  }),
};

export const commitCheckoutSchema = {
  params: z.object({ checkoutId: z.string().min(1) }),
  body: z.object({ externalRef: z.string().optional() }),
};

export const cancelCheckoutSchema = {
  params: z.object({ checkoutId: z.string().min(1) }),
  body: z.object({ reason: z.string().optional() }),
};

export const adminListSchema = {
  querystring: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    sort: z.string().default('-updatedAt'),
  }),
};

export const abandonedSchema = {
  querystring: z.object({
    daysOld: z.coerce.number().int().min(1).max(365).default(7),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }),
};

export const userIdSchema = {
  params: z.object({ userId: z.string().min(1) }),
};

export const mergeCartSchema = {
  body: z.object({ sourceCartId: z.string().min(1) }),
};
