import type { OrderContext } from '@classytic/order';
import type { FastifyRequest } from 'fastify';
import { getContextFromReq } from '#shared/context.js';

export function getFulfillmentContext(req: FastifyRequest): OrderContext {
  return getContextFromReq(req) as OrderContext;
}

export type FulfillmentLine = {
  orderLineId: string;
  quantity?: number;
};

export type FulfillmentLike = {
  orderNumber: string;
  lines?: FulfillmentLine[];
};
