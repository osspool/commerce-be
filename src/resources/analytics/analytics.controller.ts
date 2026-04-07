import type { FastifyRequest, FastifyReply } from 'fastify';
import { BaseController } from '@classytic/arc';
import Transaction from '#resources/transaction/transaction.model.js';
import Customer from '#resources/sales/customers/customer.model.js';
import Order from '#resources/sales/orders/order.model.js';
import { ORDER_STATUS, PAYMENT_STATUS } from '#resources/sales/orders/order.enums.js';

// Dummy repository for analytics (no actual data storage)
const dummyRepository = {
  getAll: async () => ({ data: [], total: 0 }),
  getById: async (_id: string) => null,
  create: async (_data: unknown) => null,
  update: async (_id: string, _data: unknown) => null,
  delete: async (_id: string) => null,
};

interface DashboardQuery {
  period?: '7d' | '30d';
}

interface AggResult {
  _id: string | null;
  sum?: number;
  avg?: number;
  count?: number;
  total?: number;
}

/**
 * Analytics Controller
 * Ecommerce dashboard analytics (single-tenant)
 */
class AnalyticsController extends BaseController {
  constructor() {
    super(dummyRepository);
    this.getDashboard = this.getDashboard.bind(this);
  }

  async getDashboard(request: FastifyRequest<{ Querystring: DashboardQuery }>, reply: FastifyReply): Promise<void> {
    const { period = '30d' } = request.query;

    const now = new Date();
    const today = new Date();
    const dayStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const periodDays = period === '7d' ? 7 : 30;
    const periodStart = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);

    // Revenue query helper (use flow: 'inflow' for revenue)
    const revenueMatch = (dateRange?: Record<string, unknown>) => ({
      flow: 'inflow',
      status: { $in: ['verified', 'completed'] },
      ...(dateRange || {}),
    });

    // Order query helper
    const orderMatch = (dateRange?: Record<string, unknown>) => ({
      status: { $ne: ORDER_STATUS.CANCELLED },
      ...(dateRange || {}),
    });

    const [
      totalCustomers,
      todaysCustomers,
      totalOrders,
      todaysOrders,
      periodOrders,
      ordersByStatus,
      totalRevenueAgg,
      todaysRevenueAgg,
      periodRevenueAgg,
      revenueByCategory,
      revenueByMethod,
      avgOrderValue,
    ] = await Promise.all([
      Customer.countDocuments(),
      Customer.countDocuments({ createdAt: { $gte: dayStart, $lt: dayEnd } }),
      Order.countDocuments(orderMatch()),
      Order.countDocuments(orderMatch({ createdAt: { $gte: dayStart, $lt: dayEnd } })),
      Order.countDocuments(orderMatch({ createdAt: { $gte: periodStart } })),
      Order.aggregate([{ $match: orderMatch() }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      Transaction.aggregate([{ $match: revenueMatch() }, { $group: { _id: null, sum: { $sum: '$amount' } } }]),
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
        { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]),
      Transaction.aggregate([
        { $match: revenueMatch({ createdAt: { $gte: periodStart } }) },
        { $group: { _id: '$method', total: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]),
      Order.aggregate([
        {
          $match: {
            status: { $in: [ORDER_STATUS.CONFIRMED, ORDER_STATUS.SHIPPED, ORDER_STATUS.DELIVERED] },
            'currentPayment.status': PAYMENT_STATUS.VERIFIED,
          },
        },
        { $group: { _id: null, avg: { $avg: '$totalAmount' } } },
      ]),
    ]);

    // Format orders by status
    const statusBreakdown: Record<string, number> = {};
    (ordersByStatus as AggResult[]).forEach((item) => {
      if (item._id) statusBreakdown[item._id] = item.count || 0;
    });

    return reply.code(200).send({
      success: true,
      data: {
        summary: {
          totalCustomers,
          totalOrders,
          totalRevenue: (totalRevenueAgg as AggResult[])[0]?.sum || 0,
          averageOrderValue: Math.round((avgOrderValue as AggResult[])[0]?.avg || 0),
        },
        today: {
          newCustomers: todaysCustomers,
          newOrders: todaysOrders,
          revenue: (todaysRevenueAgg as AggResult[])[0]?.sum || 0,
        },
        period: {
          days: periodDays,
          orders: periodOrders,
          revenue: (periodRevenueAgg as AggResult[])[0]?.sum || 0,
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
