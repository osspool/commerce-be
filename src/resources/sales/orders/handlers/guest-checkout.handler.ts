/**
 * Guest Checkout Handler
 *
 * Thin adapter that allows unauthenticated users to place orders.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import Product from '#resources/catalog/products/product.model.js';
import customerRepository from '#resources/sales/customers/customer.repository.js';
import { idempotencyService } from '#resources/commerce/core/index.js';
import { createOrderWorkflow } from '../workflows/index.js';
import { filterOrderCostPriceByUser } from '../order.costPrice.utils.js';

/** Fields to populate -- matches cart repository population */
const PRODUCT_SELECT =
  'name images basePrice currentPrice discount slug shipping productType variants variationAttributes category';

interface GuestCheckoutBody {
  items: Array<{ productId: string; variantSku?: string; quantity: number }>;
  guest: { name: string; phone: string; email?: string };
  deliveryAddress: Record<string, unknown>;
  delivery: Record<string, unknown>;
  paymentMethod?: string;
  paymentData?: Record<string, unknown>;
  couponCode?: string;
  promoCodes?: string[];
  isGift?: boolean;
  branchId?: string;
  branchSlug?: string;
  notes?: string;
  idempotencyKey?: string;
}

interface StatusError extends Error {
  statusCode?: number;
  code?: string;
  originalError?: unknown;
}

/**
 * POST /orders/guest
 */
export async function guestCheckoutHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const {
    items,
    guest,
    deliveryAddress,
    delivery,
    paymentMethod,
    paymentData,
    couponCode,
    promoCodes,
    isGift,
    branchId,
    branchSlug,
    notes,
    idempotencyKey,
  } = request.body as GuestCheckoutBody;

  try {
    // 1. Populate product data for the submitted items
    const productIds = [...new Set(items.map((i) => i.productId))];
    const products = await Product.find({ _id: { $in: productIds } })
      .select(PRODUCT_SELECT)
      .lean();

    const productMap = new Map(products.map((p) => [p._id.toString(), p]));

    // Build cart-shaped items (same structure as populated cart items)
    const cartItems: Array<{ product: Record<string, unknown>; variantSku: string | null; quantity: number }> = [];
    for (const item of items) {
      const product = productMap.get(item.productId);
      if (!product) {
        return reply.code(400).send({
          success: false,
          message: `Product not found: ${item.productId}`,
        });
      }

      // Validate variant exists if specified
      if (item.variantSku) {
        const variants = product.variants as Array<Record<string, unknown>> | undefined;
        const variant = variants?.find((v: Record<string, unknown>) => v.sku === item.variantSku);
        if (!variant) {
          return reply.code(400).send({
            success: false,
            message: `Invalid variant SKU "${item.variantSku}" for product "${product.name}"`,
          });
        }
        if (variant.isActive === false) {
          return reply.code(400).send({
            success: false,
            message: `Variant "${item.variantSku}" is not available for product "${product.name}"`,
          });
        }
      }

      cartItems.push({
        product,
        variantSku: item.variantSku || null,
        quantity: item.quantity,
      });
    }

    // 2. Resolve or create customer from guest info
    const customer = await customerRepository.findOrCreateByPhone({
      name: guest.name,
      phone: guest.phone,
      email: guest.email,
    });

    // 3. Idempotency check
    if (idempotencyKey) {
      const payloadForHash = {
        source: 'guest',
        guestPhone: guest.phone,
        cartItems: cartItems.map((i) => ({
          productId: (i.product._id as Record<string, unknown>)?.toString?.() || String(i.product._id),
          variantSku: i.variantSku || null,
          quantity: i.quantity,
        })),
        delivery,
        deliveryAddress,
        couponCode,
        promoCodes,
        paymentData,
        notes,
        branchId,
        branchSlug,
      };

      const { isNew, existingResult } = await idempotencyService.check(idempotencyKey, payloadForHash);
      if (!isNew && existingResult) {
        return reply.code(200).send({
          success: true,
          data: existingResult,
          meta: {
            message: 'Order already exists (idempotent)',
            cached: true,
          },
        });
      }
    }

    // 4. Assemble order input for workflow
    const orderInput = {
      cartItems,
      deliveryAddress,
      delivery,
      paymentMethod,
      paymentData,
      couponCode,
      promoCodes,
      isGift,
      branchId,
      branchSlug,
      notes,
      idempotencyKey,
      source: 'guest',
      _resolvedCustomer: customer,
      _resolvedUserId: null,
    };

    const requestContext = {
      request: {
        user: null,
        log: request.log,
      },
    };

    // 5. Create order via shared workflow
    const result = await createOrderWorkflow(orderInput as Record<string, unknown>, requestContext);

    // Guest users never see cost price data
    const safeOrder = filterOrderCostPriceByUser(result.order, null);

    // Cache idempotency result
    idempotencyService.complete(idempotencyKey, safeOrder);

    return reply.code(201).send({
      success: true,
      data: safeOrder,
      meta: {
        message: 'Order created successfully',
        transaction: result.transaction?._id,
        paymentIntent: result.paymentIntent,
      },
    });
  } catch (error) {
    idempotencyService.fail(idempotencyKey, error as Error | null);
    request.log.error(error);

    const err = error as StatusError;
    const meta: Record<string, unknown> = {};
    if (err.code) {
      meta.code = err.code;
    }
    if (err.originalError && process.env.NODE_ENV !== 'production') {
      meta.details = err.originalError;
    }

    return reply.code(err.statusCode || 400).send({
      success: false,
      message: err.message || 'Failed to create order',
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    });
  }
}
