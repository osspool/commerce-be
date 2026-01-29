/**
 * Guest Checkout Handler
 *
 * Thin adapter that allows unauthenticated users to place orders.
 * FE stores cart in localStorage and sends items[] in the request body.
 * Guest identity is provided via { name, phone, email }.
 *
 * Populates product data from DB, resolves/creates a Customer by phone,
 * then delegates to the same createOrderWorkflow used by authenticated checkout.
 */

import Product from '#modules/catalog/products/product.model.js';
import customerRepository from '#modules/sales/customers/customer.repository.js';
import { idempotencyService } from '#modules/commerce/core/index.js';
import { createOrderWorkflow } from '../workflows/index.js';
import { filterOrderCostPriceByUser } from '../order.costPrice.utils.js';

/** Fields to populate — matches cart repository population */
const PRODUCT_SELECT =
  'name images basePrice currentPrice discount slug shipping productType variants variationAttributes category';

/**
 * POST /orders/guest
 */
export async function guestCheckoutHandler(request, reply) {
  const {
    items,
    guest,
    deliveryAddress,
    delivery,
    paymentMethod,
    paymentData,
    couponCode,
    isGift,
    branchId,
    branchSlug,
    notes,
    idempotencyKey,
  } = request.body;

  try {
    // 1. Populate product data for the submitted items
    const productIds = [...new Set(items.map(i => i.productId))];
    const products = await Product.find({ _id: { $in: productIds } })
      .select(PRODUCT_SELECT)
      .lean();

    const productMap = new Map(products.map(p => [p._id.toString(), p]));

    // Build cart-shaped items (same structure as populated cart items)
    const cartItems = [];
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
        const variant = product.variants?.find(v => v.sku === item.variantSku);
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

    // 3. Idempotency check (same pattern as authenticated checkout)
    if (idempotencyKey) {
      const payloadForHash = {
        source: 'guest',
        guestPhone: guest.phone,
        cartItems: cartItems.map(i => ({
          productId: i.product._id.toString(),
          variantSku: i.variantSku || null,
          quantity: i.quantity,
        })),
        delivery,
        deliveryAddress,
        couponCode,
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
      isGift,
      branchId,
      branchSlug,
      notes,
      idempotencyKey,
      source: 'guest',
      // Pre-resolved customer (skips linkOrCreateForUser in workflow)
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
    const result = await createOrderWorkflow(orderInput, requestContext);

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
    idempotencyService.fail(idempotencyKey, error);
    request.log.error(error);

    const meta = {};
    if (error.code) {
      meta.code = error.code;
    }
    if (error.originalError && process.env.NODE_ENV !== 'production') {
      meta.details = error.originalError;
    }

    return reply.code(error.statusCode || 400).send({
      success: false,
      message: error.message || 'Failed to create order',
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    });
  }
}
