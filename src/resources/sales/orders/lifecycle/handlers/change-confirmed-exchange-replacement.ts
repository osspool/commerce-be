/**
 * order:change.confirmed (exchange) → create the outbound replacement Order.
 *
 * Exchange flow architecture (Shopify "draft order swap" / Odoo "exchange picking"):
 *
 *   Original order   →  Return change confirmed   →  Replacement Order
 *   ──────────────       ──────────────────────       ─────────────────
 *   ORD-A (qty 1, item M)   CHG (return M, exchange)   ORD-B (qty 1, item L)
 *   COGS posted              COGS reversed              new COGS posts on ship
 *   Revenue recognized       Revenue reversed/refund    new revenue recognized
 *   Payment captured         (handled by refund leg)    new payment intent
 *
 * Why a NEW order, not a fulfillment patch on the original:
 *   1. Pure accounting: original fully unwinds, replacement stands on its own.
 *      Payment captured for size-M doesn't have to be re-bound to size-L; the
 *      replacement gets its own payment intent and price-delta surfaces as a
 *      regular charge / refund on that order.
 *   2. Stock reservation goes through the standard place flow → oversell
 *      protection works without bespoke logic.
 *   3. Customer-facing return windows, fulfillment tracking, marketplace sync
 *      are per-order in every commerce platform's data model — patching lines
 *      in-place breaks those expectations.
 *   4. Linkage preserved via metadata both directions:
 *        change.metadata.replacementOrderId → ORD-B
 *        ORD-B.metadata.replacedFromChangeNumber → CHG
 *      so the dashboard can surface "replacement of ORD-A" on ORD-B and
 *      "exchanged for ORD-B" on the original change.
 *
 * Body for the replacement (copied from the original, channel pinned):
 *   { channel, payment.method/gateway, branchId,
 *     lines: [{ offerId: <replacement productId>, variantSku, quantity }],
 *     shippingAddress, billingAddress, customer,
 *     metadata: { replacedFromOrderId, replacedFromChangeNumber, source: 'exchange' } }
 *
 * The placement service reserves stock; if reservation fails (replacement
 * out of stock) we log + emit `order:exchange.replacement_unavailable` and
 * stamp the change with `metadata.replacementError` for admin retry.
 *
 * Idempotent via `change.metadata.replacementOrderId` — set after create.
 *
 * Resolution of the replacement variant:
 *   `internalNote` is a JSON-serialised payload set by the customer/admin
 *   handlers (`{ replacementSku }`) when changeType=exchange. The handler
 *   parses it; missing replacementSku is a misconfiguration, not a runtime
 *   error — log warn and exit silently.
 *
 * Handler is wired AFTER stock-return + ledger handlers but BEFORE the
 * refund handler. Stock for the original goods has already been restocked
 * by `change-confirmed-stock-return.ts`; we don't double-process anything.
 */

import { ensureCatalogEngine } from '#resources/catalog/catalog.engine.js';
import { executePlacement } from '../../placement.service.js';
import type { HandlerDeps, TransitionContext, TransitionHandler } from '../handler.js';
import { loadOrderByNumber } from '../load-order.js';
import { stringifyOrgId } from './_shared.js';

interface ReplacementPayload {
  replacementSku?: string;
}

function parseReplacementSku(internalNote: unknown): string | undefined {
  if (typeof internalNote !== 'string' || internalNote.length === 0) return undefined;
  try {
    const parsed = JSON.parse(internalNote) as ReplacementPayload;
    return parsed.replacementSku;
  } catch {
    return undefined;
  }
}

async function resolveReplacementProductId(
  variantSku: string,
): Promise<{ productId: string; productName: string } | null> {
  const catalog = await ensureCatalogEngine();
  // Match either a variant.sku or a product.sku (simple products without variants).
  const product = (await catalog.repositories.product.getByQuery(
    { $or: [{ 'variants.sku': variantSku }, { sku: variantSku }] } as Record<string, unknown>,
    { lean: true, throwOnNotFound: false },
  )) as { _id: { toString(): string }; name: string } | null;
  if (!product) return null;
  return { productId: String(product._id), productName: product.name };
}

export const changeConfirmedExchangeReplacementHandler: TransitionHandler = {
  event: 'order:change.confirmed',
  name: 'lifecycle.change-confirmed-exchange-replacement',

  async handle(ctx: TransitionContext, deps: HandlerDeps): Promise<void> {
    // Exchange placement can fail at runtime (replacement out of stock,
    // catalog mis-configured, etc.). Catch so the failure stamps onto the
    // change for admin retry instead of leaking a 500 up through withRetry's
    // dead-letter path. The kernel's `requestChange` already validated
    // structural inputs before confirm; here we only catch domain-data errors.
    try {
      await runExchange(ctx, deps);
    } catch (err) {
      const e = err as Error;
      deps.logger.error?.(
        { changeNumber: ctx.changeNumber, err: e.message, stack: e.stack },
        'change-confirmed-exchange-replacement: failed — stamping replacementError on change',
      );
      if (ctx.changeNumber) {
        await deps.engine.models.OrderChange.updateOne(
          { changeNumber: ctx.changeNumber },
          {
            $set: {
              'metadata.replacementError': e.message?.slice(0, 500) ?? 'unknown',
              'metadata.replacementErrorAt': new Date(),
            },
          },
        ).catch((stampErr: unknown) => {
          // Best-effort error stamp on the change. If the stamp itself fails
          // we log + continue so the original `throw err` below still surfaces
          // the real exchange failure to the caller.
          deps.logger.warn?.(
            { changeNumber: ctx.changeNumber, originalErr: e.message, stampErr },
            'change-confirmed-exchange-replacement: failed to stamp replacementError on change',
          );
        });
      }
      throw err;
    }
  },
};

async function runExchange(ctx: TransitionContext, deps: HandlerDeps): Promise<void> {
    const changeNumber = ctx.changeNumber;
    if (!changeNumber) return;
    deps.logger.debug?.(
      { changeNumber, fromStatus: ctx.fromStatus, toStatus: ctx.toStatus },
      'change-confirmed-exchange-replacement: handler entered',
    );

    const change = (await deps.engine.repositories.orderChange.getByQuery(
      { changeNumber },
      { throwOnNotFound: false } as unknown as Parameters<
        typeof deps.engine.repositories.orderChange.getByQuery
      >[1],
    )) as Record<string, unknown> | null;
    if (!change) return;
    if (String(change.changeType ?? '') !== 'exchange') return;

    // Idempotent across event-bus retries / replays.
    const meta = (change.metadata as Record<string, unknown> | undefined) ?? {};
    if (meta.replacementOrderId) return;

    const replacementSku = parseReplacementSku(change.internalNote);
    if (!replacementSku) {
      deps.logger.warn?.(
        { changeNumber },
        'change-confirmed-exchange-replacement: no replacementSku in internalNote, skipping',
      );
      return;
    }

    const orderNumber = String(change.orderNumber ?? '');
    const originalOrder = await loadOrderByNumber(deps.engine, orderNumber);
    if (!originalOrder || !originalOrder._id) return;

    const orgId = stringifyOrgId(originalOrder.organizationId);
    if (!orgId) return;

    // Resolve the replacement variant to a (productId, sku) pair the placement
    // service understands. SKU must exist in the catalog AND be either a
    // variant of some product or that product's parent SKU.
    const resolved = await resolveReplacementProductId(replacementSku);
    if (!resolved) {
      deps.logger.warn?.(
        { changeNumber, replacementSku },
        'change-confirmed-exchange-replacement: replacement SKU not found in catalog',
      );
      await deps.engine.models.OrderChange.updateOne(
        { changeNumber },
        { $set: { 'metadata.replacementError': 'sku_not_found', 'metadata.replacementErrorAt': new Date() } },
      );
      return;
    }

    // Sum the exchange quantities (sum of all RETURN_ITEM actions on this change).
    // Multi-action exchange where the customer wants the SAME replacement for all
    // items returned. For mixed-replacement use-cases (different replacement per
    // line) the kernel currently models them as separate changes.
    const actions = (change.actions as Array<{ type?: string; quantity?: number }> | undefined) ?? [];
    const totalQty = actions
      .filter((a) => a.type === 'return_item' && (a.quantity ?? 0) > 0)
      .reduce((sum, a) => sum + (a.quantity as number), 0);
    if (totalQty <= 0) return;

    // Carry payment method, addresses, and customer from the original order.
    // The new order's payment is captured/charged independently of the original;
    // price delta surfaces as a regular charge or post-place refund on ORD-B.
    //
    // Field shapes on the persisted order:
    //   - `customerSnapshot: { name, email, phone }` is what the kernel writes
    //     (not `customer` — we hand the placement service `customer:` because
    //     it converts back to `customerSnapshot` on insert)
    //   - `payment` may be present from the original placement; if not, fall
    //     back to `metadata.paymentGateway` then to `cod`
    const orig = originalOrder as {
      _id: unknown;
      orderNumber?: string;
      channel?: string;
      payment?: { method?: string; gateway?: string };
      shippingAddress?: Record<string, unknown>;
      billingAddress?: Record<string, unknown>;
      customer?: Record<string, unknown>;
      customerSnapshot?: { name?: string; email?: string; phone?: string };
      customerId?: unknown;
      metadata?: { paymentGateway?: string };
    };
    const inheritedPayment = orig.payment
      ?? (orig.metadata?.paymentGateway
        ? { method: orig.metadata.paymentGateway, gateway: orig.metadata.paymentGateway }
        : { method: 'cod', gateway: 'cod' });

    const inheritedCustomer = orig.customerSnapshot
      ? {
          ...(orig.customerId ? { customerId: String(orig.customerId) } : {}),
          ...(orig.customerSnapshot.name ? { name: orig.customerSnapshot.name } : {}),
          ...(orig.customerSnapshot.email ? { email: orig.customerSnapshot.email } : {}),
          ...(orig.customerSnapshot.phone ? { phone: orig.customerSnapshot.phone } : {}),
        }
      : orig.customer;

    if (!inheritedCustomer) {
      throw new Error(
        `Cannot create replacement: original order ${orderNumber} has no customerSnapshot`,
      );
    }

    const placementBody: Record<string, unknown> = {
      channel: orig.channel ?? 'web',
      payment: inheritedPayment,
      branchId: orgId,
      lines: [{ offerId: resolved.productId, variantSku: replacementSku, quantity: totalQty }],
      ...(orig.shippingAddress ? { shippingAddress: orig.shippingAddress } : {}),
      ...(orig.billingAddress ? { billingAddress: orig.billingAddress } : {}),
      customer: inheritedCustomer,
      metadata: {
        replacedFromOrderId: String(orig._id),
        replacedFromOrderNumber: orderNumber,
        replacedFromChangeNumber: changeNumber,
        source: 'exchange',
      },
      // Distinct idempotency key from the original — guards against retries
      // creating duplicate replacement orders.
      idempotencyKey: `exchange-${changeNumber}`,
    };

    const result = await executePlacement({
      body: placementBody,
      ctx: {
        actorRef: 'system',
        actorKind: 'system',
        organizationId: orgId,
        correlationId: `exchange-${changeNumber}`,
      } as Parameters<typeof executePlacement>[0]['ctx'],
      logger: deps.logger as Parameters<typeof executePlacement>[0]['logger'],
    });

    if (result.status >= 400) {
      const errBody = result.body as { message?: string; details?: unknown };
      deps.logger.warn?.(
        { changeNumber, replacementSku, status: result.status, error: errBody.message },
        'change-confirmed-exchange-replacement: placement failed (likely out of stock)',
      );
      await deps.engine.models.OrderChange.updateOne(
        { changeNumber },
        {
          $set: {
            'metadata.replacementError': errBody.message ?? 'placement_failed',
            'metadata.replacementErrorAt': new Date(),
            'metadata.replacementErrorDetails': errBody.details,
          },
        },
      );
      return;
    }

    const newOrder = result.body as { _id?: unknown; orderNumber?: string };
    const newOrderId = String(newOrder._id ?? '');
    const newOrderNumber = String(newOrder.orderNumber ?? '');

    await deps.engine.models.OrderChange.updateOne(
      { changeNumber },
      {
        $set: {
          'metadata.replacementOrderId': newOrderId,
          'metadata.replacementOrderNumber': newOrderNumber,
          'metadata.replacementCreatedAt': new Date(),
          'metadata.replacementProductId': resolved.productId,
          'metadata.replacementProductName': resolved.productName,
          'metadata.replacementQuantity': totalQty,
        },
      },
    );

    deps.logger.info?.(
      {
        changeNumber,
        originalOrder: orderNumber,
        replacementOrder: newOrderNumber,
        replacementSku,
        quantity: totalQty,
      },
      'change-confirmed-exchange-replacement: replacement order created',
    );
}
