/**
 * Loyalty Event Handlers
 *
 * Subscribes to loyalty engine events and syncs the thin
 * Customer.membership projection for quick reads.
 */
import { LoyaltyEvents } from '@classytic/loyalty/events';
import Customer from '../customers/customer.model.js';
import { getLoyaltyEngine } from './loyalty.plugin.js';

let _registered = false;

/**
 * Register event handlers that keep Customer.membership in sync with LoyaltyMember.
 * Call this after the loyalty engine is initialized.
 * Idempotent — safe to call multiple times.
 */
export function registerLoyaltyEventHandlers(): void {
  if (_registered) return;
  _registered = true;

  const engine = getLoyaltyEngine();

  // Points changes → sync balance
  engine.events.on(LoyaltyEvents.POINTS_EARNED, (p) => syncBalance(p as any));
  engine.events.on(LoyaltyEvents.POINTS_ADJUSTED, (p) => syncBalance(p as any));
  engine.events.on(LoyaltyEvents.POINTS_EXPIRED, (p) => syncBalanceBatch(p as any));

  // Tier changes → sync tier
  engine.events.on(LoyaltyEvents.TIER_UPGRADED, (p) => syncTier(p as any));
  engine.events.on(LoyaltyEvents.TIER_DOWNGRADED, (p) => syncTier(p as any));
}

async function syncBalance(payload: { externalId: string; balanceAfter: number }) {
  try {
    const engine = getLoyaltyEngine();
    const member = await engine.services.member.getByExternalId(payload.externalId, 'customer', { actorId: 'system' });
    if (!member) return;

    await Customer.findByIdAndUpdate(payload.externalId, {
      'membership.points.current': member.balance.current,
      'membership.points.lifetime': member.balance.lifetime,
      'membership.points.redeemed': member.balance.redeemed,
      'membership.syncedAt': new Date(),
    });
  } catch {
    // Non-critical — log but don't fail the main operation
  }
}

async function syncBalanceBatch(payload: Record<string, unknown>) {
  try {
    const result = payload as { membersAffected?: number; memberIds?: string[] };
    const engine = getLoyaltyEngine();

    // If engine provides memberIds, sync each affected member
    if (result.memberIds?.length) {
      for (const memberId of result.memberIds) {
        try {
          const member = await engine.services.member.getById(memberId, { actorId: 'system' });
          if (member?.externalId) {
            await syncBalance({ externalId: member.externalId, balanceAfter: member.balance.current });
          }
        } catch {
          // Continue syncing remaining members
        }
      }
    }
  } catch {
    // Non-critical
  }
}

async function syncTier(payload: { externalId: string; newTier: string | null }) {
  try {
    await Customer.findByIdAndUpdate(payload.externalId, {
      'membership.tier': payload.newTier,
      'membership.syncedAt': new Date(),
    });
  } catch {
    // Non-critical
  }
}
