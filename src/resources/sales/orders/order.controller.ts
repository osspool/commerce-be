/**
 * Order Controller
 *
 * Extends BaseController with custom create method that uses workflow.
 * Cart-first checkout: FE sends delivery/payment/coupon, BE fetches cart items only.
 * Other custom operations (refund, cancel, fulfill) use dedicated handlers.
 */

import { BaseController } from '@classytic/arc';
import type { FastifyRequest, FastifyReply } from 'fastify';
import orderRepository from './order.repository.js';
import { orderSchemaOptions } from './order.schemas.js';
import { createOrderWorkflow } from './workflows/index.js';
import cartRepository from '#resources/sales/cart/cart.repository.js';
import { idempotencyService } from '#resources/commerce/core/index.js';
import { filterOrderCostPriceByUser } from './order.costPrice.utils.js';

interface AuthenticatedUser {
  _id?: string;
  id?: string;
  role?: string | string[];
  [key: string]: unknown;
}

interface RequestContext {
  user: AuthenticatedUser;
  body?: Record<string, unknown>;
  context?: {
    log?: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  };
  validated?: { query: Record<string, unknown> };
  query: Record<string, unknown>;
  params: Record<string, unknown>;
}

class OrderController extends BaseController {
  constructor() {
    super(orderRepository, { schemaOptions: orderSchemaOptions });
    // Bind methods to preserve 'this' context
    this.create = this.create.bind(this);
  }

  /**
   * Create order (checkout from cart)
   */
  async create(context?: unknown): Promise<any> {
    const ctx = context as RequestContext;
    const idempotencyKey = ctx.body?.idempotencyKey as string | undefined;
    try {
      const userId = ctx.user._id;
      const orderPayload = ctx.body;

      // 1. Fetch cart items
      const cart = await cartRepository.getOrCreateCart(userId as string);
      if (!cart?.items || cart.items.length === 0) {
        return {
          success: false,
          error: 'Cart is empty. Add items to cart before checkout.',
          status: 400,
        };
      }

      // 1.5 Web checkout idempotency
      if (idempotencyKey) {
        const payloadForHash = {
          source: 'web',
          userId: userId?.toString(),
          cartItems: cart.items.map((i: unknown) => {
            const item = i as Record<string, unknown>;
            return {
              productId: (item.product as Record<string, unknown>)?._id?.toString?.() || String(item.product),
              variantSku: item.variantSku || null,
              quantity: item.quantity,
            };
          }),
          delivery: orderPayload?.delivery,
          deliveryAddress: orderPayload?.deliveryAddress,
          couponCode: orderPayload?.couponCode,
          promoCodes: orderPayload?.promoCodes,
          paymentData: orderPayload?.paymentData,
          notes: orderPayload?.notes,
          branchId: orderPayload?.branchId,
          branchSlug: orderPayload?.branchSlug,
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
        cartItems: cart.items,
      };

      const requestContext = {
        request: {
          user: ctx.user,
          log: ctx.context?.log || console,
        },
      };

      // 3. Create order via workflow
      const result = await createOrderWorkflow(orderInput as Record<string, unknown>, requestContext);

      const safeOrder = filterOrderCostPriceByUser(result.order, ctx.user);
      idempotencyService.complete(idempotencyKey, safeOrder);

      // 4. Clear customer cart after successful order
      try {
        await cartRepository.clearCart(userId as string);
      } catch (cartError) {
        if (ctx.context?.log) {
          ctx.context.log.warn('Failed to clear cart after order:', (cartError as Error).message);
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
      idempotencyService.fail(idempotencyKey, error as Error | null);

      if (ctx.context?.log) {
        ctx.context.log.error(error);
      }

      const meta: Record<string, unknown> = {};

      if ((error as Record<string, unknown>).code) {
        meta.code = (error as Record<string, unknown>).code;
      }

      if ((error as Record<string, unknown>).originalError && process.env.NODE_ENV !== 'production') {
        meta.details = (error as Record<string, unknown>).originalError;
      }

      return {
        success: false,
        error: (error as Error).message || 'Failed to create order',
        status: (error as Record<string, unknown>).statusCode || 400,
        meta: Object.keys(meta).length > 0 ? meta : undefined,
      };
    }
  }

  // Override getAll/getById to prevent leaking cost fields to non-privileged roles
  async getAll(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const typedReq = req as unknown as RequestContext;
    const rawQuery = typedReq.validated?.query || typedReq.query;
    const queryParams = this.queryParser.parse(rawQuery) as Record<string, unknown>;
    const options: Record<string, unknown> = { context: { userId: typedReq.user?.id || typedReq.user?._id } };

    const lookups = queryParams.lookups as unknown[] | undefined;
    if (lookups && lookups.length > 0) {
      const result = await (
        this as unknown as Record<string, (...args: unknown[]) => Promise<Record<string, unknown>>>
      )._getAllWithLookups(reply, queryParams, options);
      if (result.data) {
        result.data = filterOrderCostPriceByUser(result.data, typedReq.user);
      }
      return result as unknown as undefined;
    }

    const paginationParams: Record<string, unknown> = {
      ...(queryParams.page !== undefined ? { page: queryParams.page } : {}),
      ...(queryParams.after ? { after: queryParams.after } : {}),
      limit: queryParams.limit,
      filters: queryParams.filters,
      sort: queryParams.sort,
      ...(queryParams.search ? { search: queryParams.search } : {}),
    };

    const repoOptions: Record<string, unknown> = {
      ...options,
      populate: queryParams.populate || (options as Record<string, unknown>).populate,
      ...(queryParams.select ? { select: queryParams.select } : {}),
    };

    const result = (await this.repository.getAll({ ...paginationParams, ...repoOptions })) as Record<string, unknown>;
    if (result.docs) {
      result.docs = filterOrderCostPriceByUser(result.docs, typedReq.user);
    }
    return reply.code(200).send({ success: true, ...result });
  }

  async getById(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const typedReq = req as unknown as RequestContext;
    const options = { context: { userId: typedReq.user?.id || typedReq.user?._id } };
    const document = await this.repository.getById(typedReq.params.id as string, options);
    const filtered = filterOrderCostPriceByUser(document, typedReq.user);
    return reply.code(200).send({ success: true, data: filtered });
  }
}

export default new OrderController();
