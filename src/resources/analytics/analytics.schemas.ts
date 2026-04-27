/**
 * Analytics Schemas
 * Query validation for ecommerce dashboard analytics
 */
import { z } from 'zod';

export const dashboardQuery = z
  .object({
    period: z.enum(['7d', '30d']).default('30d'),
  })
  .strict();

export default {
  dashboardQuery,
};
