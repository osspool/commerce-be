/**
 * Pins the loyalty company-wide scoping fix (2026-05).
 *
 * Per industry standard (Sephora Beauty Insider, Nike Membership, Starbucks
 * Rewards) loyalty is a SINGLE program across the entire company — one
 * earning-rule set, one tier ladder, one balance per member regardless of
 * which branch they shop at.
 *
 * be-prod's `loyalty.plugin.ts` has `tenant: false` so the package-side
 * multi-tenant plugin is off. But the FE-facing resources (earning-rule,
 * tier, referral) used Arc's adapter which auto-injects `organizationId`
 * filters from the active session — silently re-scoping reads back to a
 * single branch.
 *
 * The fix: `tenantField: false` on the resource definition so the adapter
 * skips the org filter. This test pins that contract — a rule created
 * under one branch context must be visible under any other branch.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let replSet: MongoMemoryReplSet;
let earningRuleResource: { adapter?: { repository?: unknown } } & Record<string, unknown>;
let tierResource: { adapter?: { repository?: unknown } } & Record<string, unknown>;
let referralResource: { adapter?: { repository?: unknown } } & Record<string, unknown>;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGO_URI = replSet.getUri();
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.JWT_REFRESH_SECRET = 'b'.repeat(40);
  process.env.COOKIE_SECRET = 'c'.repeat(40);
  process.env.BETTER_AUTH_SECRET = 'd'.repeat(40);
  process.env.NODE_ENV = 'test';
  if (mongoose.connection.readyState !== 1) await mongoose.connect(process.env.MONGO_URI);

  // Resource modules eagerly call ensureLoyaltyEngine on import — booting
  // the loyalty kernel + registering the schemas.
  earningRuleResource = (await import(
    '../../../src/resources/sales/loyalty/earning-rule.resource.js'
  )).default as typeof earningRuleResource;
  tierResource = (await import(
    '../../../src/resources/sales/loyalty/tier.resource.js'
  )).default as typeof tierResource;
  referralResource = (await import(
    '../../../src/resources/sales/loyalty/referral.resource.js'
  )).default as typeof referralResource;
}, 120_000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 30_000);

describe('Loyalty resource scoping — company-wide invariant', () => {
  it('earning-rule resource declares tenantField: false', () => {
    expect(earningRuleResource.tenantField).toBe(false);
  });

  it('tier resource declares tenantField: false', () => {
    expect(tierResource.tenantField).toBe(false);
  });

  it('referral resource declares tenantField: false', () => {
    expect(referralResource.tenantField).toBe(false);
  });
});

describe('Loyalty engine — package-side tenant config', () => {
  it('loyalty.plugin.ts boots the engine with tenant: false', async () => {
    // Smoke test: import the plugin module + ensure it doesn't throw on the
    // tenant: false path. The engine singleton is shared across the app.
    const { ensureLoyaltyEngine } = await import('../../../src/resources/sales/loyalty/loyalty.plugin.js');
    const engine = await ensureLoyaltyEngine();
    expect(engine).toBeTruthy();
    expect(engine.repositories).toBeTruthy();
    expect(engine.repositories.earningRule).toBeTruthy();
    expect(engine.repositories.tierDefinition).toBeTruthy();
  });
});

describe('Loyalty repositories — cross-branch read parity', () => {
  beforeEach(async () => {
    const collections = ['loyalty_earning_rules', 'loyalty_tier_definitions', 'loyalty_referrals'];
    for (const name of collections) {
      try {
        await mongoose.connection.collection(name).deleteMany({});
      } catch {
        // collection may not exist on first run
      }
    }
  });

  it('earning rule created under branch A is visible from branch B (one global program)', async () => {
    const { ensureLoyaltyEngine } = await import('../../../src/resources/sales/loyalty/loyalty.plugin.js');
    const engine = await ensureLoyaltyEngine();
    const branchA = new mongoose.Types.ObjectId();
    const branchB = new mongoose.Types.ObjectId();

    // Stamp the rule with branch A's organizationId for audit, but the
    // package's tenant: false config means reads aren't filtered.
    await engine.repositories.earningRule.create(
      {
        programId: 'default',
        name: 'global-rule',
        type: 'order',
        status: 'active',
        priority: 10,
        conditions: { categories: [], tiers: [], actions: [], dayOfWeek: [] },
        reward: { amountPerPoint: 100, roundingMode: 'floor' },
        organizationId: branchA,
      } as never,
      { organizationId: String(branchA), actorId: 'test' } as never,
    );

    // Read with branch B's context — must still see the rule.
    const docsFromBranchB = await engine.repositories.earningRule.findAll(
      {},
      { organizationId: String(branchB) } as never,
    );
    expect(docsFromBranchB.length).toBe(1);
    expect((docsFromBranchB[0] as { name?: string })?.name).toBe('global-rule');

    // Read without any branch context — also visible.
    const docsUnscoped = await engine.repositories.earningRule.findAll({});
    expect(docsUnscoped.length).toBe(1);
  });
});
