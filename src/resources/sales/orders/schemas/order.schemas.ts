import { z } from 'zod';

const idParam = z.object({ id: z.string().min(1) });
const orderNumberParam = z.object({ orderNumber: z.string().min(1) });

const lineInput = z.object({}).loose();
const numericInput = z.union([z.number(), z.string()]);

export const placeOrderSchema = {
  body: z.object({}).loose(),
};

export const validateStockSchema = {
  body: z
    .object({
      lines: z.array(lineInput).optional(),
    })
    .loose(),
};

export const listMyOrdersSchema = {
  querystring: z
    .object({
      page: z.string().optional(),
      limit: z.string().optional(),
      status: z.string().optional(),
      sort: z.string().optional(),
    })
    .loose(),
};

export const myOrderSchema = {
  params: idParam,
};

export const orderEventsSchema = {
  params: orderNumberParam,
  querystring: z
    .object({
      page: z.string().optional(),
      limit: z.string().optional(),
    })
    .loose(),
};

export const orderActionSchema = {
  params: idParam,
  body: z
    .object({
      action: z.string().min(1),
      reason: z.string().optional(),
    })
    .loose(),
};

export const paymentStateSchema = {
  params: idParam,
  body: z.object({}).loose(),
};

export const codSettlementSchema = {
  params: idParam,
  body: z
    .object({
      actualReceived: numericInput,
      courierCommission: numericInput,
      writeoff: numericInput.optional(),
      cashAccount: z.enum(['1111', '1112']).optional(),
      notes: z.string().optional(),
      date: z.string().optional(),
    })
    .loose(),
};

export const refundOrderSchema = {
  params: idParam,
  body: z
    .object({
      amount: numericInput.optional(),
      reason: z.string().optional(),
      restockItems: z.union([z.boolean(), z.string()]).optional(),
    })
    .loose(),
};
