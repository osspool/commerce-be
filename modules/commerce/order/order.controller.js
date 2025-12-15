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
   * - Reserves inventory atomically
   * - Creates order + transaction
   * - Clears cart on success
   */
  async create(request, reply) {
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

      // 4. Clear customer cart after successful order
      try {
        await cartRepository.clearCart(userId);
      } catch (cartError) {
        // Log but don't fail the order
        request.log.warn('Failed to clear cart after order:', cartError.message);
      }

      return reply.code(201).send({
        success: true,
        data: result.order,
        transaction: result.transaction?._id,
        paymentIntent: result.paymentIntent,
        message: 'Order created successfully',
      });
    } catch (error) {
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
}

export default new OrderController();
