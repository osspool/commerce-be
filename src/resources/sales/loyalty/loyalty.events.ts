/**
 * Loyalty Event Handlers
 *
 * Subscribes to loyalty engine events via the Arc-compatible
 * `EventTransport.subscribe()` API and syncs the thin
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
export async function registerLoyaltyEventHandlers(): Promise<void> {
  if (_registered) return;
  _registered = true;

  const engine = getLoyaltyEngine();

  // Points changes → sync balance
  await engine.events.subscribe(LoyaltyEvents.POINTS_EARNED, (event) =>
    syncBalance(event.payload as { externalId: string; balanceAfter: number }),
  );
  await engine.events.subscribe(LoyaltyEvents.POINTS_ADJUSTED, (event) =>
    syncBalance(event.payload as { externalId: string; balanceAfter: number }),
  );
  await engine.events.subscribe(LoyaltyEvents.POINTS_EXPIRED, (event) =>
    syncBalanceBatch(event.payload as Record<string, unknown>),
  );

  // Tier changes → sync tier
  await engine.events.subscribe(LoyaltyEvents.TIER_UPGRADED, (event) =>
    syncTier(event.payload as { externalId: string; newTier: string | null }),
  );
  await engine.events.subscribe(LoyaltyEvents.TIER_DOWNGRADED, (event) =>
    syncTier(event.payload as { externalId: string; newTier: string | null }),
  );
}

async function syncBalance(payload: { externalId: string; balanceAfter: number }) {
  try {
    const engine = getLoyaltyEngine();
    const member = await engine.repositories.member.getByQuery(
      { externalId: payload.externalId, externalType: 'customer' },
      { throwOnNotFound: false },
    );
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

    if (result.memberIds?.length) {
      for (const memberId of result.memberIds) {
        try {
          const member = await engine.repositories.member.getById(memberId, { throwOnNotFound: false });
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
