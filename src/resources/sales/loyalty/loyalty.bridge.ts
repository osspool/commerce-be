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

/**
 * Forecast points for an order without persisting — same algorithm as
 * `engine.repositories.earningRule.evaluateOrder` (priority-sorted active
 * rules → condition match → reward math → tier_bonus accumulator) minus
 * the `earnPoints` write.
 *
 * Used by `POST /loyalty/preview` so checkout/POS can render "you'll earn N
 * points" labels driven by the same rule set the engine will use at
 * order-paid time. Replicating the algorithm host-side instead of adding it
 * to the engine package keeps the kernel free of dry-run paths and lets us
 * ship without a `@classytic/loyalty` re-publish.
 */
interface PreviewItem {
  categoryId?: string;
  amount: number;
  quantity: number;
}

interface RuleConditions {
  minOrderAmount?: number;
  categories?: string[];
  tiers?: string[];
  dayOfWeek?: number[];
  dateRange?: { start?: Date; end?: Date };
}

interface RuleReward {
  pointsPerAmount?: number;
  amountPerPoint?: number;
  fixedPoints?: number;
  multiplier?: number;
  roundingMode?: 'floor' | 'round' | 'ceil';
  maxPointsPerTransaction?: number;
}

interface EarningRuleLike {
  _id: string;
  name: string;
  type: 'order' | 'action' | 'category' | 'tier_bonus';
  priority: number;
  conditions?: RuleConditions;
  reward: RuleReward;
}

interface MemberLike {
  tier?: string | null;
  tierOverride?: string | null;
}

function applyRounding(v: number, mode?: 'floor' | 'round' | 'ceil'): number {
  if (mode === 'ceil') return Math.ceil(v);
  if (mode === 'round') return Math.round(v);
  return Math.floor(v);
}

function ruleMatches(rule: EarningRuleLike, member: MemberLike, orderTotal: number): boolean {
  const c = rule.conditions ?? {};
  if (c.minOrderAmount && orderTotal < c.minOrderAmount) return false;
  if (c.tiers && c.tiers.length > 0) {
    const memberTier = member.tierOverride ?? member.tier ?? null;
    if (!memberTier || !c.tiers.includes(memberTier)) return false;
  }
  const now = new Date();
  if (c.dateRange?.start && now < new Date(c.dateRange.start)) return false;
  if (c.dateRange?.end && now > new Date(c.dateRange.end)) return false;
  if (c.dayOfWeek && c.dayOfWeek.length > 0 && !c.dayOfWeek.includes(now.getDay())) return false;
  return true;
}

function orderRulePoints(rule: EarningRuleLike, orderTotal: number): number {
  const r = rule.reward;
  let p = 0;
  if (r.pointsPerAmount) p = orderTotal * r.pointsPerAmount;
  else if (r.amountPerPoint && r.amountPerPoint > 0) p = orderTotal / r.amountPerPoint;
  return applyRounding(p, r.roundingMode);
}

function categoryRulePoints(rule: EarningRuleLike, items: PreviewItem[]): number {
  const c = rule.conditions ?? {};
  const r = rule.reward;
  if (!c.categories || c.categories.length === 0) return 0;
  let p = 0;
  for (const item of items) {
    if (item.categoryId && c.categories.includes(item.categoryId)) {
      if (r.pointsPerAmount) p += item.amount * r.pointsPerAmount;
      else if (r.amountPerPoint) p += item.amount / r.amountPerPoint;
    }
  }
  return applyRounding(p, r.roundingMode);
}

export interface PreviewResult {
  totalPoints: number;
  breakdown: Array<{ ruleId: string; ruleName: string; points: number }>;
}

export async function previewPointsForOrder(input: {
  customerId: string;
  /** Order total in BDT-major (not paisa) — caller converts at the boundary. */
  orderTotal: number;
  items?: PreviewItem[];
}): Promise<PreviewResult> {
  if (!input.orderTotal || input.orderTotal <= 0) return { totalPoints: 0, breakdown: [] };

  // Kill switch
  let enabled = false;
  try {
    const config = (await platformRepository.getConfig()) as { membership?: { enabled?: boolean } } | null;
    enabled = !!config?.membership?.enabled;
  } catch {
    return { totalPoints: 0, breakdown: [] };
  }
  if (!enabled) return { totalPoints: 0, breakdown: [] };

  const engine = getLoyaltyEngine();
  const member = await engine.repositories.member.getByQuery(
    { externalId: input.customerId, externalType: 'customer' },
    { throwOnNotFound: false },
  );
  if (!member || member.status !== 'active') return { totalPoints: 0, breakdown: [] };

  const rules = (await engine.repositories.earningRule.getAll({
    filters: { status: 'active', programId: member.programId },
    sort: { priority: 1 },
    limit: 100,
  })) as unknown as { docs?: EarningRuleLike[] } | EarningRuleLike[];

  const ruleDocs = Array.isArray(rules) ? rules : (rules.docs ?? []);
  const orderRules = ruleDocs
    .filter((r) => r.type === 'order' || r.type === 'category' || r.type === 'tier_bonus')
    .sort((a, b) => a.priority - b.priority);

  const breakdown: PreviewResult['breakdown'] = [];
  let accumulated = 0;
  const memberLite: MemberLike = { tier: member.tier, tierOverride: member.tierOverride };

  for (const rule of orderRules) {
    if (!ruleMatches(rule, memberLite, input.orderTotal)) continue;
    let points = 0;
    if (rule.type === 'order') points = orderRulePoints(rule, input.orderTotal);
    else if (rule.type === 'category' && input.items) points = categoryRulePoints(rule, input.items);
    else if (rule.type === 'tier_bonus') {
      const m = rule.reward.multiplier ?? 1;
      points = Math.floor(accumulated * (m - 1));
    }
    if (points <= 0) continue;
    if (rule.reward.maxPointsPerTransaction && points > rule.reward.maxPointsPerTransaction) {
      points = rule.reward.maxPointsPerTransaction;
    }
    accumulated += points;
    breakdown.push({ ruleId: String(rule._id), ruleName: rule.name, points });
  }

  return { totalPoints: accumulated, breakdown };
}

