/**
 * Order Controller
 * 
 * Extends BaseController with custom create method that uses workflow.
 * Cart-first checkout: FE sends delivery/payment/coupon, BE fetches cart items only.
 * Other custom operations (refund, cancel, fulfill) use dedicated handlers.
 */

import BaseController from '#common/controllers/baseController.js';
import orderRepository from './order.repository.js';
import { orderSchemaOptions } from './order.schemas.js';
import { createOrderWorkflow } from './workflows/index.js';
import cartRepository from '#modules/commerce/cart/cart.repository.js';
import { idempotencyService } from '../core/index.js';
import { filterOrderCostPriceByUser } from './order.costPrice.utils.js';
import { queryParser } from '@classytic/mongokit/utils';

class OrderController extends BaseController {
  constructor() {
    super(orderRepository, orderSchemaOptions);
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
  async create(request, reply) {
    const idempotencyKey = request.body?.idempotencyKey;
    try {
      const userId = request.user._id;
      const orderPayload = request.body;

      // 1. Fetch cart items
      const cart = await cartRepository.getOrCreateCart(userId);
      if (!cart.items || cart.items.length === 0) {
        return reply.code(400).send({
          success: false,
          message: 'Cart is empty. Add items to cart before checkout.',
        });
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
          return reply.code(200).send({
            success: true,
            data: existingResult,
            message: 'Order already exists (idempotent)',
            cached: true,
          });
        }
      }

      // 2. Pass cart items + FE payload to workflow
      const orderInput = {
        ...orderPayload,
        cartItems: cart.items, // Pass populated cart items to workflow
      };

      const context = {
        request, // Workflow will use request.user to get/create customer
      };

      // 3. Create order via workflow (handles everything)
      const result = await createOrderWorkflow(orderInput, context);

      // Mark idempotency as complete (cache the created order for retries)
      const safeOrder = filterOrderCostPriceByUser(result.order, request.user);
      idempotencyService.complete(idempotencyKey, safeOrder);

      // 4. Clear customer cart after successful order
      try {
        await cartRepository.clearCart(userId);
      } catch (cartError) {
        // Log but don't fail the order
        request.log.warn('Failed to clear cart after order:', cartError.message);
      }

      return reply.code(201).send({
        success: true,
        data: safeOrder,
        transaction: result.transaction?._id,
        paymentIntent: result.paymentIntent,
        message: 'Order created successfully',
      });
    } catch (error) {
      idempotencyService.fail(idempotencyKey, error);
      request.log.error(error);

      const response = {
        success: false,
        message: error.message || 'Failed to create order',
      };

      // Include error code if available (from revenue library errors)
      if (error.code) {
        response.code = error.code;
      }

      // Include original error for debugging (only in development)
      if (error.originalError && process.env.NODE_ENV !== 'production') {
        response.details = error.originalError;
      }

      return reply.code(error.statusCode || 400).send(response);
    }
  }

  // Override getAll/getById to prevent leaking cost fields to non-privileged roles
  async getAll(req, reply) {
    const rawQuery = req.validated?.query || req.query;
    const queryParams = queryParser.parseQuery(rawQuery);
    const options = this._buildContext(req);

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
    };

    const result = await this.service.getAll(paginationParams, repoOptions);
    if (result.docs) {
      result.docs = filterOrderCostPriceByUser(result.docs, req.user);
    }
    return reply.code(200).send({ success: true, ...result });
  }

  async getById(req, reply) {
    const options = this._buildContext(req);
    const document = await this.service.getById(req.params.id, options);
    const filtered = filterOrderCostPriceByUser(document, req.user);
    return reply.code(200).send({ success: true, data: filtered });
  }
}

export default new OrderController();
