/**
 * ApprovalPolicy route schemas — Zod v4. Arc auto-converts via `z.toJSONSchema()`.
 */
import { z } from 'zod';

const conditionSchema = z.object({
  field: z.string().min(1),
  op: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'in', 'nin']),
  value: z.union([z.number(), z.string(), z.boolean(), z.array(z.union([z.number(), z.string()]))]),
});

const stepTemplateSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    userIds: z.array(z.string().min(1)).optional(),
    roles: z.array(z.string().min(1)).optional(),
    requiredApprovals: z.number().int().min(1).optional(),
  })
  .refine(
    (s) => (s.userIds?.length ?? 0) + (s.roles?.length ?? 0) > 0,
    { message: 'Each step needs at least one userId or role' },
  );

const chainTemplateSchema = z.object({
  order: z.enum(['sequential', 'parallel']),
  steps: z.array(stepTemplateSchema).min(1),
});

export const policyBodySchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  subjectType: z.string().min(1).max(64),
  branchId: z.string().nullable().optional(),
  conditions: z.array(conditionSchema).default([]),
  chainTemplate: chainTemplateSchema,
  priority: z.number().int().default(0),
  active: z.boolean().default(true),
});

export const previewSchema = {
  body: z.object({
    subjectType: z.string().min(1),
    evaluationContext: z.record(z.string(), z.unknown()),
  }),
};
