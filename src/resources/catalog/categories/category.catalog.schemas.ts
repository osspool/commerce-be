/**
 * Zod v4 schemas for catalog-backed category routes.
 */

import { z } from 'zod';

export const slugParam = z.object({
  slug: z.string().min(1).describe('Category slug'),
});

export const parentSlugParam = z.object({
  parentSlug: z.string().min(1).describe('Parent category slug'),
});
