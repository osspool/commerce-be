/**
 * Order Controller
 * 
 * Extends BaseController with custom create method that uses workflow.
 * Cart-first checkout: FE sends delivery/payment/coupon, BE fetches cart items only.
 * Other custom operations (refund, cancel, fulfill) use dedicated handlers.
 */

import { BaseController } from '@classytic/arc';
import orderRepository from './order.repository.js';
import { orderSchemaOptions } from './order.schemas.js';
import { createOrderWorkflow } from './workflows/index.js';
import cartRepository from '#modules/sales/cart/cart.repository.js';
import { idempotencyService } from '#modules/commerce/core/index.js';
import { filterOrderCostPriceByUser } from './order.costPrice.utils.js';

class OrderController extends BaseController {
  constructor() {
    super(orderRepository, { schemaOptions: orderSchemaOptions });
    // Bind methods to preserve 'this' context
    this.create = this.create.bind(this);
  }

  /**
   * Create order (checkout from cart)
   *
   * Frontend sends:
   * - deliveryAddress { addressLine1, city, phone, ... } (direct object)
   * - delivery { method, price } (shipping info)
   * - couponCode (optional)
   * - paymentData { type, reference?, senderPhone?, paymentDetails? }
   * - notes (optional)
   *
   * Backend:
   * - Fetches cart items (only source for products)
   * - Validates coupon and calculates discount
   * - Validates stock availability (no decrement for web checkout)
   * - Creates order + transaction
   * - Clears cart on success
   */
  async create(context) {
    const idempotencyKey = context.body?.idempotencyKey;
    try {
      const userId = context.user._id;
      const orderPayload = context.body;

      // 1. Fetch cart items
      const cart = await cartRepository.getOrCreateCart(userId);
      if (!cart.items || cart.items.length === 0) {
        return {
          success: false,
          error: 'Cart is empty. Add items to cart before checkout.',
          status: 400,
        };
      }

      // 1.5 Web checkout idempotency (client-provided key strongly recommended)
      // Prevents duplicate orders on flaky networks / payment retries.
      if (idempotencyKey) {
        const payloadForHash = {
          source: 'web',
          userId: userId.toString(),
          cartItems: cart.items.map(i => ({
            productId: i.product?._id?.toString?.() || i.product?.toString?.(),
            variantSku: i.variantSku || null,
            quantity: i.quantity,
          })),
          delivery: orderPayload.delivery,
          deliveryAddress: orderPayload.deliveryAddress,
          couponCode: orderPayload.couponCode,
          paymentData: orderPayload.paymentData,
          notes: orderPayload.notes,
          branchId: orderPayload.branchId,
          branchSlug: orderPayload.branchSlug,
        };

        const { isNew, existingResult } = await idempotencyService.check(idempotencyKey, payloadForHash);
        if (!isNew && existingResult) {
          return {
            success: true,
            data: existingResult,
            status: 200,
            meta: {
              message: 'Order already exists (idempotent)',
              cached: true,
            },
          };
        }
      }

      // 2. Pass cart items + FE payload to workflow
      const orderInput = {
        ...orderPayload,
        cartItems: cart.items, // Pass populated cart items to workflow
      };

      // Reconstruct request-like object for workflow (temporary until workflow is refactored)
      const requestContext = {
        request: {
          user: context.user,
          log: context.context?.log || console,
        },
      };

      // 3. Create order via workflow (handles everything)
      const result = await createOrderWorkflow(orderInput, requestContext);

      // Mark idempotency as complete (cache the created order for retries)
      const safeOrder = filterOrderCostPriceByUser(result.order, context.user);
      idempotencyService.complete(idempotencyKey, safeOrder);

      // 4. Clear customer cart after successful order
      try {
        await cartRepository.clearCart(userId);
      } catch (cartError) {
        // Log but don't fail the order
        if (context.context?.log) {
          context.context.log.warn('Failed to clear cart after order:', cartError.message);
        }
      }

      return {
        success: true,
        data: safeOrder,
        status: 201,
        meta: {
          message: 'Order created successfully',
          transaction: result.transaction?._id,
          paymentIntent: result.paymentIntent,
        },
      };
    } catch (error) {
      idempotencyService.fail(idempotencyKey, error);

      // Log error if logger is available
      if (context.context?.log) {
        context.context.log.error(error);
      }

      const meta = {};

      // Include error code if available (from revenue library errors)
      if (error.code) {
        meta.code = error.code;
      }

      // Include original error for debugging (only in development)
      if (error.originalError && process.env.NODE_ENV !== 'production') {
        meta.details = error.originalError;
      }

      return {
        success: false,
        error: error.message || 'Failed to create order',
        status: error.statusCode || 400,
        meta: Object.keys(meta).length > 0 ? meta : undefined,
      };
    }
  }

  // Override getAll/getById to prevent leaking cost fields to non-privileged roles
  async getAll(req, reply) {
    const rawQuery = req.validated?.query || req.query;
    const queryParams = this.queryParser.parse(rawQuery);
    const options = this._buildContext(req);

    // Check if query includes lookups (custom field joins)
    if (queryParams.lookups && queryParams.lookups.length > 0) {
      const result = await this._getAllWithLookups(reply, queryParams, options);
      // Filter cost prices for lookup results
      if (result.data) {
        result.data = filterOrderCostPriceByUser(result.data, req.user);
      }
      return result;
    }

    const paginationParams = {
      ...(queryParams.page !== undefined && { page: queryParams.page }),
      ...(queryParams.after && { after: queryParams.after }),
      limit: queryParams.limit,
      filters: queryParams.filters,
      sort: queryParams.sort,
      ...(queryParams.search && { search: queryParams.search }),
    };

    const repoOptions = {
      ...options,
      populate: queryParams.populate || options.populate,
      ...(queryParams.select && { select: queryParams.select }),
    };

    const result = await this.repository.getAll(paginationParams, repoOptions);
    if (result.docs) {
      result.docs = filterOrderCostPriceByUser(result.docs, req.user);
    }
    return reply.code(200).send({ success: true, ...result });
  }

  async getById(req, reply) {
    const options = this._buildContext(req);
    const document = await this.repository.getById(req.params.id, options);
    const filtered = filterOrderCostPriceByUser(document, req.user);
    return reply.code(200).send({ success: true, data: filtered });
  }
}

export default new OrderController();
