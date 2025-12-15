import Transaction from '#modules/transaction/transaction.model.js';
import Customer from '#modules/customer/customer.model.js';
import Order from '#modules/commerce/order/order.model.js';
import { ORDER_STATUS, PAYMENT_STATUS } from '#modules/commerce/order/order.enums.js';

/**
 * Analytics Controller
 * Ecommerce dashboard analytics (single-tenant)
 */
class AnalyticsController {
  /**
   * Get dashboard analytics
   * @param {Object} request - Fastify request
   * @param {Object} reply - Fastify reply
   */
  async getDashboard(request, reply) {
    const { period = '30d' } = request.query;

    const now = new Date();
    const today = new Date();
    const dayStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const periodDays = period === '7d' ? 7 : 30;
    const periodStart = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);

    // Revenue query helper
    const revenueMatch = (dateRange) => ({
      type: 'income',
      status: { $in: ['verified', 'completed'] },
      ...(dateRange || {}),
    });

    // Order query helper
    const orderMatch = (dateRange) => ({
      status: { $ne: ORDER_STATUS.CANCELLED },
      ...(dateRange || {}),
    });

    const [
      // Customer stats
      totalCustomers,
      todaysCustomers,
      
      // Order stats
      totalOrders,
      todaysOrders,
      periodOrders,
      ordersByStatus,
      
      // Revenue stats
      totalRevenueAgg,
      todaysRevenueAgg,
      periodRevenueAgg,
      revenueByCategory,
      revenueByMethod,
      
      // Average order value
      avgOrderValue,
    ] = await Promise.all([
      // Customers
      Customer.countDocuments(),
      Customer.countDocuments({ createdAt: { $gte: dayStart, $lt: dayEnd } }),
      
      // Orders
      Order.countDocuments(orderMatch()),
      Order.countDocuments(orderMatch({ createdAt: { $gte: dayStart, $lt: dayEnd } })),
      Order.countDocuments(orderMatch({ createdAt: { $gte: periodStart } })),
      Order.aggregate([
        { $match: orderMatch() },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      
      // Revenue
      Transaction.aggregate([
        { $match: revenueMatch() },
        { $group: { _id: null, sum: { $sum: '$amount' } } },
      ]),
      Transaction.aggregate([
        { $match: revenueMatch({ createdAt: { $gte: dayStart, $lt: dayEnd } }) },
        { $group: { _id: null, sum: { $sum: '$amount' } } },
      ]),
      Transaction.aggregate([
        { $match: revenueMatch({ createdAt: { $gte: periodStart } }) },
        { $group: { _id: null, sum: { $sum: '$amount' } } },
      ]),
      Transaction.aggregate([
        { $match: revenueMatch({ createdAt: { $gte: periodStart } }) },
        { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]),
      Transaction.aggregate([
        { $match: revenueMatch({ createdAt: { $gte: periodStart } }) },
        { $group: { _id: '$method', total: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]),
      
      // Average order value
      Order.aggregate([
        {
          $match: {
            status: { $in: [ORDER_STATUS.CONFIRMED, ORDER_STATUS.SHIPPED, ORDER_STATUS.DELIVERED] },
            'currentPayment.status': PAYMENT_STATUS.VERIFIED,
          }
        },
        { $group: { _id: null, avg: { $avg: '$totalAmount' } } },
      ]),
    ]);

    // Format orders by status
    const statusBreakdown = {};
    ordersByStatus.forEach(item => {
      statusBreakdown[item._id] = item.count;
    });

    return reply.code(200).send({
      success: true,
      data: {
        summary: {
          totalCustomers,
          totalOrders,
          totalRevenue: totalRevenueAgg[0]?.sum || 0,
          averageOrderValue: Math.round(avgOrderValue[0]?.avg || 0),
        },
        today: {
          newCustomers: todaysCustomers,
          newOrders: todaysOrders,
          revenue: todaysRevenueAgg[0]?.sum || 0,
        },
        period: {
          days: periodDays,
          orders: periodOrders,
          revenue: periodRevenueAgg[0]?.sum || 0,
        },
        orders: {
          byStatus: {
            pending: statusBreakdown[ORDER_STATUS.PENDING] || 0,
            processing: statusBreakdown[ORDER_STATUS.PROCESSING] || 0,
            confirmed: statusBreakdown[ORDER_STATUS.CONFIRMED] || 0,
            shipped: statusBreakdown[ORDER_STATUS.SHIPPED] || 0,
            delivered: statusBreakdown[ORDER_STATUS.DELIVERED] || 0,
            cancelled: statusBreakdown[ORDER_STATUS.CANCELLED] || 0,
          },
        },
        revenue: {
          byCategory: revenueByCategory,
          byPaymentMethod: revenueByMethod,
        },
      },
    });
  }
}

const analyticsController = new AnalyticsController();
export default analyticsController;
