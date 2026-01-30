import {
  Repository,
  validationChainPlugin,
  requireField,
} from '@classytic/mongokit';
import Order from './order.model.js';
import Product from '#modules/catalog/products/product.model.js';
import couponRepository from '#modules/commerce/coupon/coupon.repository.js';
import { ORDER_STATUS, PAYMENT_STATUS } from './order.enums.js';

// Stats utilities
import * as customerStats from '#modules/sales/customers/customer.stats.js';
import * as productStats from '#modules/catalog/products/product.stats.js';
import { onMembershipPointsEarned } from '#modules/sales/customers/customer.stats.js';

// Inventory service for stock restoration
import { stockTransactionService } from '#modules/inventory/index.js';

// Membership utils for points restoration
import { releasePoints } from '#modules/sales/customers/membership.utils.js';

/**
 * Order Repository
 * 
 * Uses MongoKit events for:
 * - Customer stats updates (after:create, after:update)
 * - Product inventory restore on cancellation (after:update)
 * - Timeline audit via mongoose plugin on model
 * 
 * NOTE: Inventory decrement is handled ATOMICALLY in createOrderWorkflow.
 * This repository only handles stats updates and inventory restoration.
 */
class OrderRepository extends Repository {
  constructor() {
    super(Order, [
      validationChainPlugin([
        requireField('items', ['create']),
        requireField('totalAmount', ['create']),
      ]),
    ], {
      defaultLimit: 20,
      maxLimit: 100,
    });

    this._setupEventHandlers();
  }

  /**
   * Setup MongoKit event handlers for stats sync
   */
  _setupEventHandlers() {
    // Block order deletion for non-super-admin - orders are immutable for accounting/legal compliance
    // Super-admin can delete if needed for data management (testing, GDPR, etc.)
    // Note: before:* hooks receive context directly, after:* hooks receive { context, result }
    this.on('before:delete', (context) => {
      const userRoles = context?.user?.roles || context?.userRoles || [];
      const isSuperAdmin = Array.isArray(userRoles)
        ? userRoles.includes('superadmin')
        : userRoles === 'superadmin';
      if (!isSuperAdmin) {
        throw new Error('Orders cannot be deleted. Use cancellation (status: cancelled) instead. Only super-admin can delete orders.');
      }
    });

    // After order created: update customer stats only
    // NOTE: Inventory is already decremented atomically in workflow
    this.on('after:create', async ({ result }) => {
      try {
        if (result.customer) {
          await customerStats.onOrderCreated(result.customer, result);

          // For POS pickup orders (immediately delivered + verified), award points now
          const isImmediatelyCompleted = result.source === 'pos' &&
            result.status === ORDER_STATUS.DELIVERED &&
            result.currentPayment?.status === PAYMENT_STATUS.VERIFIED;

          if (isImmediatelyCompleted) {
            // Update completed order stats
            await customerStats.onOrderCompleted(result.customer, result.totalAmount);

            // Award membership points if applicable
            if (result.membershipApplied?.pointsEarned > 0) {
              await onMembershipPointsEarned(result.customer, result.membershipApplied.pointsEarned);
            }
          }
        }
        // productStats.decrementInventory() REMOVED - done atomically in workflow
      } catch (error) {
        console.error('Order after:create event error:', error.message);
      }
    });

    // After order updated: check status/payment changes
    this.on('after:update', async ({ context, result }) => {
      try {
        const { previousStatus, previousPaymentStatus } = context;
        
        // Get current payment status from currentPayment subdocument
        const currentPaymentStatus = result.currentPayment?.status;
        
        // Order completed (delivered + paid) - update sales stats
        if (
          result.status === ORDER_STATUS.DELIVERED &&
          currentPaymentStatus === PAYMENT_STATUS.VERIFIED &&
          (previousStatus !== ORDER_STATUS.DELIVERED || previousPaymentStatus !== PAYMENT_STATUS.VERIFIED)
        ) {
          if (result.customer) {
            await customerStats.onOrderCompleted(result.customer, result.totalAmount);

            // Award membership points if applicable
            if (result.membershipApplied?.pointsEarned > 0) {
              await onMembershipPointsEarned(result.customer, result.membershipApplied.pointsEarned);
            }
          }
          await productStats.onOrderItemsSold(result.items);
        }
        
        // Order cancelled - restore inventory and membership points
        if (result.status === ORDER_STATUS.CANCELLED && previousStatus !== ORDER_STATUS.CANCELLED) {
          if (result.customer) {
            await customerStats.onOrderCancelled(result.customer);

            // Restore redeemed membership points
            const redeemedPoints = result.membershipApplied?.pointsRedeemed;
            if (redeemedPoints > 0) {
              await releasePoints(result.customer, redeemedPoints).catch(err => {
                console.error(`Failed to restore ${redeemedPoints} points for customer ${result.customer}:`, err.message);
              });
            }
          }

          // Only restore stock if order was fulfilled (stock was actually decremented)
          // For web orders: check if shipping exists and was picked up/in-transit/delivered
          // For POS orders: status goes straight to delivered, always restore
          const wasFulfilled = this._wasOrderFulfilled(result, previousStatus);
          if (wasFulfilled) {
            await this._restoreOrderStock(result);
          }
        }

        // Order refunded - restore inventory, points, and revert stats
        if (currentPaymentStatus === PAYMENT_STATUS.REFUNDED && previousPaymentStatus !== PAYMENT_STATUS.REFUNDED) {
          if (result.customer) {
            await customerStats.onOrderRefunded(result.customer, result.totalAmount);

            // Restore redeemed membership points
            const redeemedPoints = result.membershipApplied?.pointsRedeemed;
            if (redeemedPoints > 0) {
              await releasePoints(result.customer, redeemedPoints).catch(err => {
                console.error(`Failed to restore ${redeemedPoints} points for customer ${result.customer}:`, err.message);
              });
            }
          }

          // Only restore stock if order was fulfilled
          const wasFulfilled = this._wasOrderFulfilled(result);
          if (wasFulfilled) {
            await this._restoreOrderStock(result);
          }

          await productStats.onOrderItemsReverted(result.items); // Revert sales stats
        }
      } catch (error) {
        console.error('Order after:update event error:', error.message);
      }
    });
  }

  /**
   * Override update to capture previous state for events
   */
  async update(id, data, options = {}) {
    const previous = await this.getById(id, { lean: true });
    return super.update(id, data, {
      ...options,
      previousStatus: previous?.status,
      previousPaymentStatus: previous?.currentPayment?.status,
    });
  }

  /**
   * Get customer's orders
   */
  async getByCustomer(customerId, params = {}) {
    return this.getAll({
      ...params,
      filters: { ...params.filters, customer: customerId },
      sort: params.sort || '-createdAt',
    });
  }

  /**
   * Calculate order totals
   */
  async calculateTotal(items, deliveryPrice = 0, couponCode = null) {
    let subtotal = 0;

    for (const item of items) {
      const product = await Product.findById(item.product);
      if (!product) throw new Error(`Product not found: ${item.product}`);

      let itemPrice = product.currentPrice || product.basePrice;

      // Variant SKU modifier
      if (item.variantSku && product.variants?.length) {
        const variant = product.variants.find(v => v.sku === item.variantSku);
        itemPrice += variant?.priceModifier || 0;
      }

      subtotal += itemPrice * item.quantity;
    }

    let discount = 0;
    let couponData = null;

    if (couponCode) {
      const coupon = await couponRepository.validateCoupon(couponCode, subtotal);
      discount = coupon.calculateDiscount(subtotal);
      couponData = {
        coupon: coupon._id,
        code: coupon.code,
        discountType: coupon.discountType,
        discountAmount: coupon.discountAmount,
      };
    }

    return {
      subtotal,
      discount,
      deliveryPrice,
      total: subtotal - discount + deliveryPrice,
      couponData,
    };
  }

  /**
   * Get order stats for analytics
   */
  async getStats(filters = {}) {
    const result = await this.aggregate([
      { $match: filters },
      {
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          totalRevenue: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ['$status', ORDER_STATUS.DELIVERED] },
                  { $eq: ['$currentPayment.status', PAYMENT_STATUS.VERIFIED] }
                ]},
                '$totalAmount',
                0
              ]
            }
          },
          avgOrderValue: { $avg: '$totalAmount' },
          pending: { $sum: { $cond: [{ $eq: ['$status', ORDER_STATUS.PENDING] }, 1, 0] } },
          completed: { $sum: { $cond: [{ $eq: ['$status', ORDER_STATUS.DELIVERED] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', ORDER_STATUS.CANCELLED] }, 1, 0] } },
        },
      },
    ]);

    return result[0] || { totalOrders: 0, totalRevenue: 0, avgOrderValue: 0, pending: 0, completed: 0, cancelled: 0 };
  }

  /**
   * Check if order was fulfilled (stock was decremented)
   * Only restore stock if order actually went through fulfillment
   */
  _wasOrderFulfilled(order, previousStatus = null) {
    // POS orders go straight to delivered, always considered fulfilled
    if (order.source === 'pos') {
      return true;
    }

    // For web orders, check shipping status or previous order status
    // If order was never shipped/fulfilled, don't restore
    const shippingStatus = order.shipping?.status;

    if (shippingStatus) {
      // If shipping was created and progressed beyond "pending", it was fulfilled
      return shippingStatus !== 'pending';
    }

    // Fallback: If previous status was "shipped" or "delivered", it was fulfilled
    if (previousStatus) {
      return ['shipped', 'delivered'].includes(previousStatus);
    }

    // If no shipping and previousStatus unknown, check current order status
    // If it reached "delivered", assume it was fulfilled
    return order.status === ORDER_STATUS.DELIVERED;
  }

  /**
   * Restore stock to inventory using stockTransactionService
   * Properly restores StockEntry and creates audit trail
   */
  async _restoreOrderStock(order) {
    try {
      // Transform order items to inventory service format
      const items = order.items.map(item => ({
        productId: item.product,
        variantSku: item.variantSku || null,
        quantity: item.quantity,
      }));

      // Use branch from order, or default branch
      const branchId = order.branch || null;

      // Restore stock via inventory service (updates StockEntry + creates movements)
      await stockTransactionService.restoreBatch(
        items,
        branchId,
        { model: 'Order', id: order._id },
        order.cancelledBy || order.refundedBy || null
      );

      console.log(`Stock restored for order ${order._id}: ${items.length} items`);
    } catch (error) {
      console.error(`Failed to restore stock for order ${order._id}:`, error.message);
      // Don't throw - continue with cancellation even if stock restore fails
    }
  }
}

export default new OrderRepository();
