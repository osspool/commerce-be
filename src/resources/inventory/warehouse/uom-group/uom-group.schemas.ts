/**
 * Unit-of-measure group schemas — Zod v4.
 */
import { z } from 'zod';

const successData = <T extends z.ZodType>(schema: T) => schema;

const idParam = z.object({ id: z.string() });

const uomConversionEntry = z.object({
  uom: z.string(),
  factor: z.number().positive(),
  description: z.string().optional(),
});

const uomGroupEntity = z.object({
  _id: z.string(),
  organizationId: z.string(),
  code: z.string(),
  name: z.string(),
  baseUom: z.string(),
  conversions: z.array(uomConversionEntry),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const uomGroupSchemas = {
  list: {
    querystring: z.object({
      code: z.string().optional(),
      limit: z.coerce.number().min(1).max(200).optional(),
    }),
    response: {
      200: z.object({
        data: z.array(uomGroupEntity),
        total: z.number(),
      }),
    },
  },
  get: { params: idParam, response: { 200: successData(uomGroupEntity) } },
  create: {
    body: z.object({
      code: z.string().min(1),
      name: z.string().min(1),
      baseUom: z.string().min(1),
      conversions: z.array(uomConversionEntry).default([]),
    }),
    response: { 201: successData(uomGroupEntity) },
  },
  update: {
    params: idParam,
    body: z.object({
      name: z.string().optional(),
      baseUom: z.string().optional(),
      conversions: z.array(uomConversionEntry).optional(),
    }),
  },
  convert: {
    body: z.object({
      groupRef: z.string(),
      quantity: z.number().nonnegative(),
      fromUom: z.string(),
      toUom: z.string().optional(),
    }),
  },
};
