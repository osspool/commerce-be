import { Repository, validationChainPlugin, requireField } from '@classytic/mongokit';
import Order from './order.model.js';
import type { IOrder, OrderDocument } from './order.model.js';
import { ORDER_STATUS, PAYMENT_STATUS } from './order.enums.js';

// Stats utilities
import * as customerStats from '#resources/sales/customers/customer.stats.js';
import * as productStats from '#resources/catalog/products/product.stats.js';

// Inventory service for stock restoration
import { stockTransactionService } from '#resources/inventory/index.js';

// Loyalty engine for points operations
import { getLoyaltyEngine } from '#resources/sales/loyalty/loyalty.plugin.js';
import * as loyaltyBridge from '#resources/sales/loyalty/loyalty.bridge.js';

interface StockItem {
  productId: unknown;
  variantSku: string | null;
  quantity: number;
}

interface OrderStats {
  totalOrders: number;
  totalRevenue: number;
  avgOrderValue: number;
  pending: number;
  completed: number;
  cancelled: number;
}

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
class OrderRepository extends Repository<IOrder> {
  constructor() {
    super(
      Order,
      [validationChainPlugin([requireField('items', ['create']), requireField('totalAmount', ['create'])])],
      {
        defaultLimit: 20,
        maxLimit: 100,
      },
    );

    this._setupEventHandlers();
  }

  /**
   * Setup MongoKit event handlers for stats sync
   */
  _setupEventHandlers(): void {
    // Block order deletion for non-super-admin
    this.on('before:delete', (context: Record<string, unknown>) => {
      const userRoles = (context?.user as Record<string, unknown>)?.role || context?.userRoles || [];
      const isSuperAdmin = Array.isArray(userRoles) ? userRoles.includes('superadmin') : userRoles === 'superadmin';
      if (!isSuperAdmin) {
        throw new Error(
          'Orders cannot be deleted. Use cancellation (status: cancelled) instead. Only super-admin can delete orders.',
        );
      }
    });

    // After order created: update customer stats only
    this.on('after:create', async ({ result }: { result: OrderDocument }) => {
      try {
        if (result.customer) {
          await customerStats.onOrderCreated(
            result.customer as unknown as string,
            result as unknown as Record<string, unknown>,
          );

          const isImmediatelyCompleted =
            result.source === 'pos' &&
            result.status === ORDER_STATUS.DELIVERED &&
            result.currentPayment?.status === PAYMENT_STATUS.VERIFIED;

          if (isImmediatelyCompleted) {
            await customerStats.onOrderCompleted(result.customer as unknown as string, result.totalAmount);

            if (result.membershipApplied?.pointsEarned && result.membershipApplied.pointsEarned > 0) {
              await earnLoyaltyPoints(
                result.customer as unknown as string,
                result.membershipApplied.pointsEarned,
                result._id?.toString(),
              );
            }
          }
        }
      } catch (error) {
        console.error('Order after:create event error:', (error as Error).message);
      }
    });

    // After order updated: check status/payment changes
    this.on(
      'after:update',
      async ({ context, result }: { context: Record<string, unknown>; result: OrderDocument }) => {
        try {
          const { previousStatus, previousPaymentStatus } = context;

          const currentPaymentStatus = result.currentPayment?.status;

          // Order completed (delivered + paid) - update sales stats
          if (
            result.status === ORDER_STATUS.DELIVERED &&
            currentPaymentStatus === PAYMENT_STATUS.VERIFIED &&
            (previousStatus !== ORDER_STATUS.DELIVERED || previousPaymentStatus !== PAYMENT_STATUS.VERIFIED)
          ) {
            if (result.customer) {
              await customerStats.onOrderCompleted(result.customer as unknown as string, result.totalAmount);

              if (result.membershipApplied?.pointsEarned && result.membershipApplied.pointsEarned > 0) {
                await earnLoyaltyPoints(
                  result.customer as unknown as string,
                  result.membershipApplied.pointsEarned,
                  result._id?.toString(),
                );
              }
            }
            await productStats.onOrderItemsSold(result.items);
          }

          // Order cancelled - restore inventory and membership points
          if (result.status === ORDER_STATUS.CANCELLED && previousStatus !== ORDER_STATUS.CANCELLED) {
            if (result.customer) {
              await customerStats.onOrderCancelled(result.customer as unknown as string);

              const redeemedPoints = result.membershipApplied?.pointsRedeemed;
              if (redeemedPoints && redeemedPoints > 0) {
                await restoreLoyaltyPoints(
                  result.customer as unknown as string,
                  redeemedPoints,
                  `Order cancelled: ${result._id}`,
                  `order_redeem_restore_cancel:${result._id}`,
                  result.branch?.toString(),
                );
              }
            }

            const wasFulfilled = this._wasOrderFulfilled(result, previousStatus as string);
            if (wasFulfilled) {
              await this._restoreOrderStock(result);
            }
          }

          // Order refunded - restore inventory, points, and revert stats
          if (currentPaymentStatus === PAYMENT_STATUS.REFUNDED && previousPaymentStatus !== PAYMENT_STATUS.REFUNDED) {
            if (result.customer) {
              await customerStats.onOrderRefunded(result.customer as unknown as string, result.totalAmount);

              const redeemedPoints = result.membershipApplied?.pointsRedeemed;
              if (redeemedPoints && redeemedPoints > 0) {
                await restoreLoyaltyPoints(
                  result.customer as unknown as string,
                  redeemedPoints,
                  `Order refunded: ${result._id}`,
                  `order_redeem_restore_refund:${result._id}`,
                  result.branch?.toString(),
                );
              }
            }

            const wasFulfilled = this._wasOrderFulfilled(result);
            if (wasFulfilled) {
              await this._restoreOrderStock(result);
            }

            await productStats.onOrderItemsReverted(result.items);
          }
        } catch (error) {
          console.error('Order after:update event error:', (error as Error).message);
        }
      },
    );
  }

  /**
   * Override update to capture previous state for events
   */
  async update(id: string, data: Record<string, unknown>, options: Record<string, unknown> = {}): Promise<IOrder> {
    const previous = (await this.getById(id, { lean: true })) as unknown as Record<string, unknown> | null;
    return super.update(id, data, {
      ...options,
      previousStatus: previous?.status,
      previousPaymentStatus: (previous?.currentPayment as Record<string, unknown>)?.status,
    } as Record<string, unknown>);
  }

  /**
   * Get customer's orders
   */
  async getByCustomer(customerId: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.getAll({
      ...params,
      filters: { ...(params.filters as Record<string, unknown>), customer: customerId },
      sort: (params.sort as string) || '-createdAt',
    });
  }

  /**
   * Get order stats for analytics
   */
  async getStats(filters: Record<string, unknown> = {}): Promise<OrderStats> {
    const result = await this.aggregate([
      { $match: filters },
      {
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          totalRevenue: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$status', ORDER_STATUS.DELIVERED] },
                    { $eq: ['$currentPayment.status', PAYMENT_STATUS.VERIFIED] },
                  ],
                },
                '$totalAmount',
                0,
              ],
            },
          },
          avgOrderValue: { $avg: '$totalAmount' },
          pending: { $sum: { $cond: [{ $eq: ['$status', ORDER_STATUS.PENDING] }, 1, 0] } },
          completed: { $sum: { $cond: [{ $eq: ['$status', ORDER_STATUS.DELIVERED] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', ORDER_STATUS.CANCELLED] }, 1, 0] } },
        },
      },
    ]);

    return (result[0] || {
      totalOrders: 0,
      totalRevenue: 0,
      avgOrderValue: 0,
      pending: 0,
      completed: 0,
      cancelled: 0,
    }) as OrderStats;
  }

  /**
   * Check if order was fulfilled (stock was decremented)
   */
  _wasOrderFulfilled(order: OrderDocument, previousStatus: string | null = null): boolean {
    if (order.source === 'pos') {
      return true;
    }

    const shippingStatus = order.shipping?.status;

    if (shippingStatus) {
      return shippingStatus !== 'pending';
    }

    if (previousStatus) {
      return ['shipped', 'delivered'].includes(previousStatus);
    }

    return order.status === ORDER_STATUS.DELIVERED;
  }

  /**
   * Restore stock to inventory using stockTransactionService
   */
  async _restoreOrderStock(order: OrderDocument): Promise<void> {
    try {
      const items: StockItem[] = order.items.map((item) => ({
        productId: item.product,
        variantSku: item.variantSku || null,
        quantity: item.quantity,
      }));

      const branchId = order.branch ? String(order.branch) : undefined;

      await stockTransactionService.restoreBatch(
        items as unknown as Array<{ productId: string; variantSku?: string; quantity: number }>,
        branchId as string,
        { model: 'Order', id: order._id },
        ((order as unknown as Record<string, unknown>).cancelledBy ||
          (order as unknown as Record<string, unknown>).refundedBy ||
          null) as string,
      );

      console.log(`Stock restored for order ${order._id}: ${items.length} items`);
    } catch (error) {
      console.error(`Failed to restore stock for order ${order._id}:`, (error as Error).message);
    }
  }
}

// ── Loyalty Engine Helpers (non-blocking, log on failure) ──

async function earnLoyaltyPoints(
  customerId: string,
  points: number,
  orderId?: string,
  branchId?: string,
): Promise<void> {
  try {
    const engine = getLoyaltyEngine();
    const ctx = { actorId: 'order-lifecycle' };
    const member = await loyaltyBridge.getMemberForCustomer(customerId, ctx);
    if (!member) return;

    await engine.services.ledger.earnPoints(
      {
        memberId: member._id,
        points,
        description: `Order completed: ${orderId || 'unknown'}`,
        referenceType: 'order',
        referenceId: orderId,
        idempotencyKey: orderId ? `order_earn:${orderId}` : undefined,
        metadata: branchId ? { branchId } : undefined,
      },
      ctx,
    );
    await loyaltyBridge.syncCustomerMembership(customerId);
  } catch (err) {
    console.error(`Failed to earn ${points} loyalty points for customer ${customerId}:`, (err as Error).message);
  }
}

async function restoreLoyaltyPoints(
  customerId: string,
  points: number,
  reason: string,
  idempotencyKey?: string,
  branchId?: string,
): Promise<void> {
  try {
    const engine = getLoyaltyEngine();
    const ctx = { actorId: 'order-lifecycle', idempotencyKey };
    const member = await loyaltyBridge.getMemberForCustomer(customerId, ctx);
    if (!member) return;

    await engine.services.ledger.adjustPoints(
      {
        memberId: member._id,
        points, // positive — restoring points
        description: reason,
        reason,
        idempotencyKey,
        metadata: branchId ? { branchId } : undefined,
      },
      ctx,
    );
    await loyaltyBridge.syncCustomerMembership(customerId);
  } catch (err) {
    console.error(`Failed to restore ${points} loyalty points for customer ${customerId}:`, (err as Error).message);
  }
}

export default new OrderRepository();
