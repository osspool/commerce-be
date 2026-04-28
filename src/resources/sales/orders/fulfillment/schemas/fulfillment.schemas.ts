import { z } from 'zod';

const idParam = z.object({ id: z.string().min(1) });
const orderNumberParam = z.object({ orderNumber: z.string().min(1) });
const lineInput = z
  .object({
    orderLineId: z.string().min(1),
    quantity: z.union([z.number(), z.string()]).optional(),
  })
  .loose();

export const createFulfillmentForOrderSchema = {
  params: orderNumberParam,
  body: z
    .object({
      fulfillmentType: z.string().optional(),
      lines: z.array(lineInput).optional(),
      warehouseId: z.string().optional(),
      vendorId: z.string().optional(),
      shippingAddress: z.object({}).loose().optional(),
      typeData: z.object({}).loose().optional(),
      metadata: z.object({}).loose().optional(),
    })
    .loose(),
};

export const fulfillmentActionSchema = {
  params: idParam,
  body: z
    .object({
      action: z.string().min(1),
    })
    .loose(),
};

export const fulfillmentTrackingSchema = {
  params: idParam,
  body: z
    .object({
      carrier: z.string(),
      trackingNumber: z.string(),
      trackingUrl: z.string().optional(),
    })
    .loose(),
};

export const listFulfillmentsForOrderSchema = {
  params: orderNumberParam,
};
