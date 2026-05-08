/**
 * Loyalty Schemas (Zod v4)
 *
 * Request/response validation + auto OpenAPI docs for
 * Members, Earning Rules, Tiers, and Referrals.
 */
import { z } from 'zod';

// ── Shared ──

const customerIdParam = z.object({ customerId: z.string() });
const ruleIdParam = z.object({ ruleId: z.string() });
const tierIdParam = z.object({ tierId: z.string() });
const referralIdParam = z.object({ referralId: z.string() });
const cardIdParam = z.object({ cardId: z.string().min(1).describe('Loyalty card ID printed on member card') });

// ── Redemption Schemas ──

const redemptionIdParam = z.object({ redemptionId: z.string() });

export const redemptionSchemas = {
  validate: {
    body: z.object({
      customerId: z.string().min(1).describe('Customer ID whose member balance should be checked'),
      pointsToRedeem: z.number().positive().describe('Points the customer wants to redeem'),
      orderTotal: z.number().positive().describe('Order total — caps the points discount'),
    }),
  },
  reserve: {
    body: z.object({
      customerId: z.string().min(1).describe('Customer ID whose member balance should be debited'),
      pointsToRedeem: z.number().positive().describe('Points to reserve'),
      orderTotal: z.number().positive().describe('Order total — caps the points discount'),
      ownerType: z
        .string()
        .min(1)
        .default('order')
        .describe('Owner kind (default: "order"). Identifies what holds the reservation.'),
      ownerId: z.string().min(1).describe('Owner id — the order/cart/quotation that holds the reservation'),
      expiresAt: z.string().datetime().optional().describe('Absolute expiry (ISO). Defaults to engine reservation TTL.'),
    }),
  },
  byId: {
    params: redemptionIdParam,
  },
};

// ── Member Schemas ──

export const memberSchemas = {
  enroll: {
    body: z.object({
      customerId: z.string().min(1).describe('Customer ID to enroll'),
    }),
  },
  adjust: {
    params: customerIdParam,
    body: z.object({
      points: z.number().describe('Points to adjust (positive = credit, negative = deduct)'),
      reason: z.string().min(3).describe('Reason for adjustment'),
    }),
  },
  history: {
    params: customerIdParam,
    querystring: z.object({
      page: z.coerce.number().optional().default(1),
      limit: z.coerce.number().optional().default(20),
    }),
  },
  tierOverride: {
    params: customerIdParam,
    body: z.object({
      tier: z.string().min(1).describe('Tier name to set'),
      reason: z.string().min(1).describe('Reason for override'),
    }),
  },
  referralsList: {
    params: customerIdParam,
    querystring: z.object({
      page: z.coerce.number().optional().default(1),
      limit: z.coerce.number().optional().default(20),
    }),
  },
  byCard: {
    params: cardIdParam,
  },
};

// ── Earning Rule Schemas ──

export const earningRuleSchemas = {
  create: {
    body: z.object({
      name: z.string().min(1).describe('Rule name'),
      type: z.enum(['order', 'action', 'category', 'tier_bonus']).describe('Rule type'),
      priority: z.number().optional().default(10),
      description: z.string().optional(),
      conditions: z
        .object({
          minOrderAmount: z.number().optional(),
          categories: z.array(z.string()).optional(),
          tiers: z.array(z.string()).optional(),
          actions: z.array(z.string()).optional(),
          dayOfWeek: z.array(z.number()).optional(),
          dateRange: z.object({ start: z.string().optional(), end: z.string().optional() }).optional(),
        })
        .optional(),
      reward: z.object({
        pointsPerAmount: z.number().optional(),
        amountPerPoint: z.number().optional(),
        fixedPoints: z.number().optional(),
        multiplier: z.number().optional(),
        roundingMode: z.enum(['floor', 'round', 'ceil']).optional(),
        maxPointsPerTransaction: z.number().optional(),
      }),
      startsAt: z.string().optional(),
      endsAt: z.string().optional(),
    }),
  },
  update: {
    params: ruleIdParam,
    body: z.object({
      name: z.string().optional(),
      priority: z.number().optional(),
      description: z.string().optional(),
      conditions: z
        .object({
          minOrderAmount: z.number().optional(),
          categories: z.array(z.string()).optional(),
          tiers: z.array(z.string()).optional(),
          actions: z.array(z.string()).optional(),
          dayOfWeek: z.array(z.number()).optional(),
          dateRange: z.object({ start: z.string().optional(), end: z.string().optional() }).optional(),
        })
        .optional(),
      reward: z
        .object({
          pointsPerAmount: z.number().optional(),
          amountPerPoint: z.number().optional(),
          fixedPoints: z.number().optional(),
          multiplier: z.number().optional(),
          roundingMode: z.enum(['floor', 'round', 'ceil']).optional(),
          maxPointsPerTransaction: z.number().optional(),
        })
        .optional(),
      startsAt: z.string().optional(),
      endsAt: z.string().optional(),
    }),
  },
  list: {
    querystring: z.object({
      page: z.coerce.number().optional().default(1),
      limit: z.coerce.number().optional().default(50),
      status: z.enum(['active', 'paused', 'expired']).optional(),
    }),
  },
};

// ── Tier Schemas ──

export const tierSchemas = {
  create: {
    body: z.object({
      name: z.string().min(1).describe('Tier name'),
      rank: z.number().describe('Tier rank (lower = higher priority)'),
      qualificationCriteria: z
        .object({
          minLifetimePoints: z.number().optional(),
          minLifetimeSpend: z.number().optional(),
          evaluationPeriodDays: z.number().optional(),
        })
        .optional(),
      benefits: z
        .object({
          pointsMultiplier: z.number().optional(),
          discountPercent: z.number().optional(),
          freeShipping: z.boolean().optional(),
          customBenefits: z.record(z.string(), z.unknown()).optional(),
        })
        .optional(),
      downgrade: z
        .object({
          enabled: z.boolean(),
          gracePeriodDays: z.number().optional(),
        })
        .optional(),
      color: z.string().optional(),
    }),
  },
  update: {
    params: tierIdParam,
    body: z.object({
      name: z.string().optional(),
      rank: z.number().optional(),
      qualificationCriteria: z
        .object({
          minLifetimePoints: z.number().optional(),
          minLifetimeSpend: z.number().optional(),
          evaluationPeriodDays: z.number().optional(),
        })
        .optional(),
      benefits: z
        .object({
          pointsMultiplier: z.number().optional(),
          discountPercent: z.number().optional(),
          freeShipping: z.boolean().optional(),
          customBenefits: z.record(z.string(), z.unknown()).optional(),
        })
        .optional(),
      downgrade: z
        .object({
          enabled: z.boolean(),
          gracePeriodDays: z.number().optional(),
        })
        .optional(),
      color: z.string().optional(),
    }),
  },
};

// ── Referral Schemas ──

export const referralSchemas = {
  record: {
    body: z.object({
      referralCode: z.string().min(1).describe('Referral code'),
      refereeCustomerId: z.string().min(1).describe('Referee customer ID'),
    }),
  },
  reject: {
    params: referralIdParam,
    body: z.object({
      reason: z.string().min(1).describe('Rejection reason'),
    }),
  },
  selfRecord: {
    body: z.object({
      referralCode: z.string().min(1).describe('Referral code to apply'),
    }),
  },
};
