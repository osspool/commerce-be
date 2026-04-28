import { z } from 'zod';

const numericInput = z.union([z.number(), z.string()]);

const cadenceInput = z
  .object({
    startAt: z.string().optional(),
    endAt: z.string().optional(),
  })
  .loose();

const lineInput = z
  .object({
    quantity: numericInput.optional(),
  })
  .loose();

export const createBlanketOrderSchema = {
  body: z
    .object({
      cadence: cadenceInput.optional(),
      startAt: z.string().optional(),
      lines: z.array(lineInput).optional(),
    })
    .loose(),
};

export const closeBlanketOrderSchema = z.object({ reason: z.string().optional() });

export const extendBlanketOrderSchema = z.object({ endAt: z.iso.datetime() });
