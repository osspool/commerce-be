/**
 * Analytics Controller
 *
 * Ecommerce dashboard analytics built on top of `@classytic/order`. All
 * order reads go directly through the engine's Mongoose model (bypassing
 * the multi-tenant plugin) because the dashboard is a super-admin view
 * that aggregates across every branch.
 *
 * Status vocabulary aligned with `@classytic/order`:
 *   - non-cancelled = `status NOT IN ('canceled', 'refunded')`
 *   - "completed" for AOV = `status IN ('delivered', 'completed', 'fulfilled')`
 *     AND `paymentState.chargeStatus = 'full'`
 */

import { BaseController, type RepositoryLike } from '@classytic/arc';
import type { FastifyReply, FastifyRequest } from 'fastify';
import Customer from '#resources/sales/customers/customer.model.js';
import { ensureOrderEngine } from '#resources/sales/orders/order.engine.js';
import { getTransactionModel } from '#shared/revenue/engine.js';

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

class AnalyticsController extends BaseController {
  constructor() {
    // Analytics is a read-only aggregation surface with no real repository.
    // `dummyRepository.delete` returns `Promise<null>` rather than
    // `Promise<DeleteResult>` — the cast bridges that structural gap. All
    // analytics routes bypass BaseController's CRUD entirely.
    super(dummyRepository as unknown as RepositoryLike<unknown>);
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

    // Revenue query helper
    const revenueMatch = (dateRange?: Record<string, unknown>) => ({
      flow: 'inflow',
      status: { $in: ['verified', 'completed'] },
      ...(dateRange || {}),
    });

    // @classytic/order states that count as "active" (not cancelled/refunded)
    const CANCELLED_STATES = ['canceled', 'refunded'];
    const COMPLETED_STATES = ['delivered', 'completed', 'fulfilled'];

    const orderMatch = (dateRange?: Record<string, unknown>) => ({
      status: { $nin: CANCELLED_STATES },
      ...(dateRange || {}),
    });

    const engine = await ensureOrderEngine();
    const Order = engine.models.Order;

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
      avgOrderValueAgg,
    ] = await Promise.all([
      Customer.countDocuments(),
      Customer.countDocuments({ createdAt: { $gte: dayStart, $lt: dayEnd } }),
      Order.countDocuments(orderMatch()),
      Order.countDocuments(orderMatch({ createdAt: { $gte: dayStart, $lt: dayEnd } })),
      Order.countDocuments(orderMatch({ createdAt: { $gte: periodStart } })),
      Order.aggregate([{ $match: orderMatch() }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      getTransactionModel().aggregate([
        { $match: revenueMatch() },
        { $group: { _id: null, sum: { $sum: '$amount' } } },
      ]),
      getTransactionModel().aggregate([
        { $match: revenueMatch({ createdAt: { $gte: dayStart, $lt: dayEnd } }) },
        { $group: { _id: null, sum: { $sum: '$amount' } } },
      ]),
      getTransactionModel().aggregate([
        { $match: revenueMatch({ createdAt: { $gte: periodStart } }) },
        { $group: { _id: null, sum: { $sum: '$amount' } } },
      ]),
      getTransactionModel().aggregate([
        { $match: revenueMatch({ createdAt: { $gte: periodStart } }) },
        { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]),
      getTransactionModel().aggregate([
        { $match: revenueMatch({ createdAt: { $gte: periodStart } }) },
        { $group: { _id: '$method', total: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]),
      Order.aggregate([
        {
          $match: {
            status: { $in: COMPLETED_STATES },
            'paymentState.chargeStatus': 'full',
          },
        },
        { $group: { _id: null, avg: { $avg: '$totals.grandTotal.amount' } } },
      ]),
    ]);

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
          averageOrderValue: Math.round((avgOrderValueAgg as AggResult[])[0]?.avg || 0),
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
            pending: statusBreakdown.pending || 0,
            processing: statusBreakdown.processing || 0,
            confirmed: statusBreakdown.confirmed || 0,
            fulfilled: statusBreakdown.fulfilled || 0,
            delivered: statusBreakdown.delivered || 0,
            completed: statusBreakdown.completed || 0,
            canceled: statusBreakdown.canceled || 0,
            refunded: statusBreakdown.refunded || 0,
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
