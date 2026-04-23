import type { LoyaltyContext } from '@classytic/loyalty/types';
import platformRepository from '#resources/platform/platform.repository.js';
import Customer from '../customers/customer.model.js';
import { generateCardId } from './card-id.js';
import { getLoyaltyEngine } from './loyalty.plugin.js';

export interface LoyaltyBridgeContext {
  actorId: string;
  /** Enrolling branch code (provenance only — card works globally) */
  branchCode?: string;
}

function toLoyaltyCtx(ctx: LoyaltyBridgeContext): LoyaltyContext {
  return { actorId: ctx.actorId };
}

/**
 * Resolve card formatting config from PlatformConfig, falling back to safe defaults.
 * Card formatting is optional policy — enrollment must never fail because config is absent.
 */
async function resolveCardConfig(): Promise<{ prefix: string; digits: number }> {
  try {
    const config = await platformRepository.getConfig();
    const mc = (config as Record<string, unknown>).membership as Record<string, unknown> | undefined;
    return {
      prefix: (mc?.cardPrefix as string) || 'MBR',
      digits: (mc?.cardDigits as number) || 8,
    };
  } catch {
    // PlatformConfig not yet bootstrapped — use safe defaults
    return { prefix: 'MBR', digits: 8 };
  }
}

/**
 * Enroll a customer in the loyalty program.
 * Creates a LoyaltyMember, generates a smart card ID with branch provenance,
 * and syncs the thin membership field on Customer.
 *
 * Card generation uses PlatformConfig when available, falls back to defaults.
 * Enrollment never fails because of missing platform config.
 */
export async function enrollCustomer(customerId: string, ctx: LoyaltyBridgeContext) {
  const engine = getLoyaltyEngine();
  const loyaltyCtx = toLoyaltyCtx(ctx);

  const customer = await Customer.findById(customerId);
  if (!customer) throw new Error('Customer not found');

  // Generate smart card ID with branch provenance (safe defaults if no config)
  const branchCode = ctx.branchCode || 'HQ';
  const cardConfig = await resolveCardConfig();
  const cardId = await generateCardId(branchCode, cardConfig);

  // Enroll in loyalty engine — cardId is first-class, branch provenance in metadata
  const member = await engine.repositories.member.enroll(
    {
      externalId: customerId,
      externalType: 'customer',
      cardId,
      metadata: { enrollingBranchCode: branchCode },
    },
    loyaltyCtx,
  );

  // Sync thin membership field on Customer
  await Customer.findByIdAndUpdate(customerId, {
    membership: {
      cardId,
      isActive: true,
      enrolledAt: new Date(),
      points: { current: 0, lifetime: 0, redeemed: 0 },
      tier: member.tier || 'Bronze',
    },
  });

  return member;
}

/**
 * Get the LoyaltyMember for a customer. Returns null if not enrolled.
 */
export async function getMemberForCustomer(customerId: string, ctx: LoyaltyBridgeContext) {
  const engine = getLoyaltyEngine();
  return engine.repositories.member.getByQuery(
    { externalId: customerId, externalType: 'customer' },
    { throwOnNotFound: false },
  );
}

/**
 * Deactivate a customer's loyalty membership.
 */
export async function deactivateCustomerMembership(customerId: string, ctx: LoyaltyBridgeContext) {
  const engine = getLoyaltyEngine();
  const loyaltyCtx = toLoyaltyCtx(ctx);
  const member = await engine.repositories.member.getByQuery(
    { externalId: customerId, externalType: 'customer' },
    { throwOnNotFound: false },
  );
  if (!member) throw new Error('Customer is not enrolled in loyalty program');

  const deactivated = await engine.repositories.member.deactivate(member._id, loyaltyCtx);

  await Customer.findByIdAndUpdate(customerId, { 'membership.isActive': false });

  return deactivated;
}

/**
 * Reactivate a customer's loyalty membership.
 */
export async function reactivateCustomerMembership(customerId: string, ctx: LoyaltyBridgeContext) {
  const engine = getLoyaltyEngine();
  const loyaltyCtx = toLoyaltyCtx(ctx);
  const member = await engine.repositories.member.getByQuery(
    { externalId: customerId, externalType: 'customer' },
    { throwOnNotFound: false },
  );
  if (!member) throw new Error('Customer is not enrolled in loyalty program');

  const reactivated = await engine.repositories.member.reactivate(member._id, loyaltyCtx);

  await Customer.findByIdAndUpdate(customerId, { 'membership.isActive': true });

  return reactivated;
}

/**
 * Sync the thin Customer.membership projection from LoyaltyMember state.
 * Projects all fields including overrides, cardId, and syncedAt timestamp.
 */
export async function syncCustomerMembership(customerId: string) {
  const engine = getLoyaltyEngine();
  const member = await engine.repositories.member.getByQuery(
    { externalId: customerId, externalType: 'customer' },
    { throwOnNotFound: false },
  );
  if (!member) return;

  await Customer.findByIdAndUpdate(customerId, {
    'membership.cardId': member.cardId || member.referralCode,
    'membership.isActive': member.status === 'active',
    'membership.points.current': member.balance.current,
    'membership.points.lifetime': member.balance.lifetime,
    'membership.points.redeemed': member.balance.redeemed,
    'membership.tier': member.tierOverride || member.tier,
    'membership.tierOverride': member.tierOverride || undefined,
    'membership.tierOverrideReason': (member as any).tierOverrideReason || undefined,
    'membership.syncedAt': new Date(),
  });
}

/**
 * Get the loyalty member ID for a customer (convenience for POS flow).
 * Throws if not enrolled.
 */
export async function requireMemberForCustomer(customerId: string, ctx: LoyaltyBridgeContext) {
  const member = await getMemberForCustomer(customerId, ctx);
  if (!member) throw new Error('Customer is not enrolled in loyalty program');
  return member;
}

// ── POS Helpers (pure config-based calculations) ──

interface MembershipTier {
  name: string;
  minPoints: number;
  pointsMultiplier?: number;
  discountPercent?: number;
}

interface MembershipConfig {
  enabled?: boolean;
  amountPerPoint?: number;
  pointsPerAmount?: number;
  roundingMode?: 'floor' | 'ceil' | 'round';
  tiers?: MembershipTier[];
}

/**
 * Calculate points earned for an order based on platform membership config.
 */
export function calculatePointsForOrder(
  orderTotal: number,
  membershipConfig: MembershipConfig,
  customerTier: string,
): number {
  if (!membershipConfig?.enabled || !orderTotal) return 0;

  const { amountPerPoint = 100, pointsPerAmount = 1, roundingMode = 'floor' } = membershipConfig;
  const tierConfig = membershipConfig.tiers?.find((t) => t.name === customerTier);
  const multiplier = tierConfig?.pointsMultiplier || 1;

  const basePoints = (orderTotal / amountPerPoint) * pointsPerAmount;
  const rawPoints = basePoints * multiplier;

  switch (roundingMode) {
    case 'ceil':
      return Math.ceil(rawPoints);
    case 'round':
      return Math.round(rawPoints);
    default:
      return Math.floor(rawPoints);
  }
}

/**
 * Get tier discount percent from platform membership config.
 */
export function getTierDiscountPercent(customerTier: string, membershipConfig: MembershipConfig): number {
  if (!membershipConfig?.enabled) return 0;
  const tierConfig = membershipConfig.tiers?.find((t) => t.name === customerTier);
  return tierConfig?.discountPercent || 0;
}
