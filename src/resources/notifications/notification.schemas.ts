import { z } from 'zod';

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  unreadOnly: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  type: z.string().optional(),
});

export const markReadParamsSchema = z.object({
  id: z.string().min(1),
});

export const notificationResponseSchema = z.object({
  _id: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  type: z.string(),
  title: z.string(),
  message: z.string(),
  data: z
    .object({
      link: z.string().optional(),
      entityId: z.string().optional(),
      entityType: z.string().optional(),
      meta: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  read: z.boolean(),
  readAt: z.string().nullable(),
  priority: z.enum(['low', 'normal', 'high']),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ListQuery = z.infer<typeof listQuerySchema>;
