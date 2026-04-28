import type { OrderContext } from '@classytic/order';
import type { FastifyRequest } from 'fastify';
import { getContextFromReq } from '#shared/context.js';
import { getEcomBranchId } from '../ecom-branch.js';
import { ensureOrderEngine } from '../order.engine.js';

export type OrderRepository = {
  getAll: (p: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getByQuery: (f: Record<string, unknown>, o?: Record<string, unknown>) => Promise<unknown | null>;
};

export type ScopedOrder = {
  _id: { toString(): string };
  orderNumber?: string;
  status?: string;
  totals?: { grandTotal?: { amount: number; currency?: string }; tax?: { amount: number } };
  metadata?: Record<string, unknown>;
  currentPayment?: { transactionId?: unknown } | null;
  paymentState?: { transactionRefs?: Array<{ type?: string; status?: string; transactionId?: string }> };
};

export function getAuthUserId(req: FastifyRequest): string | null {
  const scope = (req as unknown as { scope?: { userId?: string } }).scope;
  if (scope?.userId) return scope.userId;
  const user = (req as unknown as { user?: { _id?: string; id?: string } }).user;
  return user?._id || user?.id || null;
}

export function getOrderContext(req: FastifyRequest): OrderContext {
  return getContextFromReq(req) as OrderContext;
}

export async function getEcomPinnedContext(req: FastifyRequest): Promise<OrderContext> {
  const reqCtx = getOrderContext(req);
  const ecomBranchId = await getEcomBranchId();
  return ecomBranchId ? { ...reqCtx, organizationId: ecomBranchId } : reqCtx;
}

export function readPagination(
  query: { page?: string; limit?: string; sort?: string },
  defaults: { limit: number; maxLimit: number; sort?: string },
) {
  return {
    page: Math.max(1, parseInt(query.page ?? '1', 10) || 1),
    limit: Math.min(
      defaults.maxLimit,
      Math.max(1, parseInt(query.limit ?? String(defaults.limit), 10) || defaults.limit),
    ),
    sort: query.sort ?? defaults.sort,
  };
}

export async function getScopedOrderByNumber(id: string, ctx: OrderContext): Promise<ScopedOrder | null> {
  const engine = await ensureOrderEngine();
  return (await engine.repositories.order.getByQuery(
    { orderNumber: id, organizationId: ctx.organizationId },
    { throwOnNotFound: false },
  )) as ScopedOrder | null;
}
