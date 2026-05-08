/**
 * Cart controller — thin handlers that delegate to @classytic/cart repositories.
 *
 * BigBoss is single-tenant multi-branch, but the customer shopping cart is
 * company-wide: a customer's cart follows them regardless of branch. POS does
 * not use this package — its cart lives in the frontend. Therefore every call
 * here runs with `skipTenant: true` and no `x-organization-id` is read.
 */

import type { OperationContext } from '@classytic/cart';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getCartEngine } from './cart.engine.js';
import { NotFoundError } from '@classytic/arc/utils';

function buildCartContext(req: FastifyRequest, opts: { actorRef?: string } = {}): OperationContext {
  const user = (req as FastifyRequest & { user?: { _id?: string; id?: string } }).user;
  const actorRef = opts.actorRef ?? user?._id ?? user?.id ?? '';

  return {
    organizationId: '',
    actorRef,
    actorKind: 'user',
    correlationId: req.id,
    locale: (req.headers['accept-language'] as string | undefined)?.split(',')[0] || 'en',
    currency: process.env.DEFAULT_CURRENCY || 'BDT',
    skipTenant: true,
  } as OperationContext;
}

// ─── Repository shortcuts ─────────────────────────────────────────────────────

const draft = () => getCartEngine().repositories.draft;
const checkout = () => getCartEngine().repositories.checkout;

// ─── Shared helpers — DRY the "active cart lookup + 404" pattern ─────────────

async function requireActiveCart(ctx: OperationContext, reply: FastifyReply) {
  const active = await draft().findActiveByActor(ctx.actorRef, ctx);
  if (!active) {
    throw new NotFoundError('Cart not found');
    return null;
  }
  return active;
}

// ─── User operations ──────────────────────────────────────────────────────────

export async function getCart(req: FastifyRequest, reply: FastifyReply) {
  const ctx = buildCartContext(req);
  const cart = await draft().findActiveByActor(ctx.actorRef, ctx);
  reply.send(cart);
}

export async function addItem(req: FastifyRequest, reply: FastifyReply) {
  const { productId, variantSku, quantity, display } = req.body as {
    productId: string;
    variantSku?: string | null;
    quantity: number;
    display?: {
      name?: string;
      imageUrl?: string;
      slug?: string;
      variantLabel?: string;
      compareAtPrice?: { amount: number; currency: string } | null;
      capturedAt?: Date | string;
    };
  };

  // Normalize the client-provided display snapshot. Accepting it skips the
  // kind's displayOf() call (one catalog round-trip per add). Price is
  // still computed server-side — display fields are cosmetic and drift is
  // tolerated by design (see @classytic/cart CLAUDE.md).
  //
  // `compareAtPrice: null` (client's "no sale price" marker) collapses to
  // `undefined` — cart's `LineDisplay.compareAtPrice` is `Money | undefined`,
  // so null would fail the strict type check.
  const normalizedDisplay = display
    ? {
        ...display,
        compareAtPrice: display.compareAtPrice ?? undefined,
        capturedAt: display.capturedAt ? new Date(display.capturedAt) : new Date(),
      }
    : undefined;

  const base = variantSku
    ? { kind: 'variant' as const, payload: { productRef: productId, variantSku }, quantity }
    : { kind: 'sku' as const, payload: { skuRef: productId }, quantity };

  const item = normalizedDisplay ? { ...base, display: normalizedDisplay } : base;

  const result = await draft().addItem(item, buildCartContext(req));
  reply.send(result);
}

export async function updateItem(req: FastifyRequest, reply: FastifyReply) {
  const { itemId } = req.params as { itemId: string };
  const { quantity } = req.body as { quantity: number };
  const ctx = buildCartContext(req);

  const active = await requireActiveCart(ctx, reply);
  if (!active) return;

  const result = await draft().updateItemQuantity({ draftPublicId: active.publicId, lineId: itemId, quantity }, ctx);
  reply.send(result);
}

export async function removeItem(req: FastifyRequest, reply: FastifyReply) {
  const { itemId } = req.params as { itemId: string };
  const ctx = buildCartContext(req);

  const active = await requireActiveCart(ctx, reply);
  if (!active) return;

  const result = await draft().removeItem({ draftPublicId: active.publicId, lineId: itemId }, ctx);
  reply.send(result);
}

export async function clearCart(req: FastifyRequest, reply: FastifyReply) {
  const ctx = buildCartContext(req);
  const active = await requireActiveCart(ctx, reply);
  if (!active) return;

  const result = await draft().clear(active.publicId, ctx);
  reply.send(result);
}

// ─── Checkout ────────────────────────────────────────────────────────────────

export async function startCheckout(req: FastifyRequest, reply: FastifyReply) {
  const { expectedPricingHash } = (req.body || {}) as { expectedPricingHash?: string | null };
  const ctx = buildCartContext(req);

  const active = await requireActiveCart(ctx, reply);
  if (!active) return;

  // Cart engine treats `null` as "skip pricing-hash interlock" and any
  // string (including "") as "client expected exactly this hash". Normalize
  // missing/empty values to null so callers that omit the field don't trip
  // PriceChangedError.
  const normalizedHash = expectedPricingHash === undefined || expectedPricingHash === '' ? null : expectedPricingHash;

  const result = await checkout().createFromDraft(
    { draftPublicId: active.publicId, expectedPricingHash: normalizedHash },
    ctx,
  );
  reply.send(result);
}

export async function commitCheckout(req: FastifyRequest, reply: FastifyReply) {
  const { checkoutId } = req.params as { checkoutId: string };
  const { externalRef } = (req.body || {}) as { externalRef?: string };

  const result = await checkout().commit({ checkoutPublicId: checkoutId, externalRef }, buildCartContext(req));
  reply.send(result);
}

export async function cancelCheckout(req: FastifyRequest, reply: FastifyReply) {
  const { checkoutId } = req.params as { checkoutId: string };
  const { reason } = (req.body || {}) as { reason?: string };

  const result = await checkout().cancel(
    { checkoutPublicId: checkoutId, reason: reason || 'user_canceled' },
    buildCartContext(req),
  );
  reply.send(result);
}

// ─── Admin ────────────────────────────────────────────────────────────────────

export async function listAllCarts(req: FastifyRequest, reply: FastifyReply) {
  const {
    page = 1,
    limit = 20,
    sort = '-updatedAt',
  } = req.query as {
    page?: number;
    limit?: number;
    sort?: string;
  };

  const result = await draft().getAll(
    { filters: {}, pagination: { page: Number(page), limit: Number(limit) }, sort },
    buildCartContext(req),
  );
  reply.send(result);
}

export async function getAbandonedCarts(req: FastifyRequest, reply: FastifyReply) {
  const { daysOld = 7, limit = 20 } = req.query as { daysOld?: number; limit?: number };
  const { findAbandonedDrafts } = await import('@classytic/cart');

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - Number(daysOld));

  const data = await findAbandonedDrafts({
    repo: draft() as Parameters<typeof findAbandonedDrafts>[0]['repo'],
    cutoff,
    limit: Number(limit),
    ctx: buildCartContext(req),
  });
  reply.send({ data, metadata: { daysOld: Number(daysOld), cutoff: cutoff.toISOString() } });
}

export async function getUserCart(req: FastifyRequest, reply: FastifyReply) {
  const { userId } = req.params as { userId: string };
  const ctx = buildCartContext(req, { actorRef: userId });

  const cart = await draft().findActiveByActor(userId, ctx);
  if (!cart) {
    throw new NotFoundError('Cart not found for this user');
  }

  reply.send(cart);
}
