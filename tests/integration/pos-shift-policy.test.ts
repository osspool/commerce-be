/**
 * POS Shift Policy Resolver — unit tests.
 *
 * Pure synchronous tests of the merge function. No DB, no Fastify.
 * Integration tests for the async `resolveShiftPolicy(branchId)` are in
 * pos-shift-lifecycle.test.ts (policy snapshot at shift open).
 */

import { describe, it, expect } from 'vitest';
import { resolveShiftPolicySync } from '#resources/sales/pos/shift-policy.resolver.js';
import { DEFAULT_SHIFT_POLICY } from '#resources/sales/pos/shift.constants.js';

describe('resolveShiftPolicySync', () => {
  it('falls back to code defaults when nothing is provided', () => {
    const resolved = resolveShiftPolicySync(null, null);
    expect(resolved).toEqual(DEFAULT_SHIFT_POLICY);
  });

  it('uses platform defaults when branch has no policy', () => {
    const platform = { varianceThresholdAbs: 250, blindCloseRequired: true };
    const resolved = resolveShiftPolicySync(null, platform);
    expect(resolved.varianceThresholdAbs).toBe(250);
    expect(resolved.blindCloseRequired).toBe(true);
    // unspecified fields come from defaults
    expect(resolved.varianceThresholdPct).toBe(DEFAULT_SHIFT_POLICY.varianceThresholdPct);
    expect(resolved.allowHandover).toBe(DEFAULT_SHIFT_POLICY.allowHandover);
  });

  it('branch override wins over platform', () => {
    const branch = { varianceThresholdAbs: 500, autoCloseEnabled: true };
    const platform = { varianceThresholdAbs: 250, blindCloseRequired: true };
    const resolved = resolveShiftPolicySync(branch, platform);
    expect(resolved.varianceThresholdAbs).toBe(500); // branch wins
    expect(resolved.autoCloseEnabled).toBe(true); // branch-only
    expect(resolved.blindCloseRequired).toBe(true); // platform fills gap
  });

  it('treats null on nullable keys as explicit inheritance, not "clear"', () => {
    // `requiredOpeningFloat` and `autoCloseTime` are the two keys where
    // null is a meaningful value ("not enforced"). Branch setting them to
    // null should take effect, not fall through.
    const branch = { requiredOpeningFloat: null, autoCloseTime: null };
    const platform = { requiredOpeningFloat: 300, autoCloseTime: '04:00' };
    const resolved = resolveShiftPolicySync(branch, platform);
    expect(resolved.requiredOpeningFloat).toBeNull();
    expect(resolved.autoCloseTime).toBeNull();
  });

  it('treats null on non-nullable keys as "skip and fall through"', () => {
    // `varianceThresholdAbs` is non-nullable. A stray null from a partial
    // sub-doc read should not win over a valid platform number.
    const branch = { varianceThresholdAbs: null as unknown as number };
    const platform = { varianceThresholdAbs: 200 };
    const resolved = resolveShiftPolicySync(branch, platform);
    expect(resolved.varianceThresholdAbs).toBe(200);
  });

  it('distinct per-branch policies do not bleed into each other', () => {
    const ho = { requiredOpeningFloat: 1000, blindCloseRequired: true };
    const outlet = { requiredOpeningFloat: 300, allowHandover: false };
    const platform = { varianceThresholdAbs: 50 };

    const hoResolved = resolveShiftPolicySync(ho, platform);
    const outletResolved = resolveShiftPolicySync(outlet, platform);

    expect(hoResolved.requiredOpeningFloat).toBe(1000);
    expect(hoResolved.blindCloseRequired).toBe(true);
    expect(hoResolved.allowHandover).toBe(DEFAULT_SHIFT_POLICY.allowHandover);

    expect(outletResolved.requiredOpeningFloat).toBe(300);
    expect(outletResolved.blindCloseRequired).toBe(DEFAULT_SHIFT_POLICY.blindCloseRequired);
    expect(outletResolved.allowHandover).toBe(false);

    // Both pull platform's variance threshold.
    expect(hoResolved.varianceThresholdAbs).toBe(50);
    expect(outletResolved.varianceThresholdAbs).toBe(50);
  });

  it('arrays (allowedReasonCodes, allowedPaymentMethods) replace, not merge', () => {
    const branch = { allowedReasonCodes: ['safe_drop', 'bank_deposit'] as const };
    const platform = { allowedReasonCodes: ['other'] as const };
    const resolved = resolveShiftPolicySync(
      branch as never,
      platform as never,
    );
    expect(resolved.allowedReasonCodes).toEqual(['safe_drop', 'bank_deposit']);
  });

  it('late-night cutoff (4am) stored explicitly on branch survives', () => {
    const branch = {
      autoCloseEnabled: true,
      autoCloseTime: '04:00',
      autoCloseTimezone: 'Asia/Dhaka',
    };
    const resolved = resolveShiftPolicySync(branch, null);
    expect(resolved.autoCloseEnabled).toBe(true);
    expect(resolved.autoCloseTime).toBe('04:00');
    expect(resolved.autoCloseTimezone).toBe('Asia/Dhaka');
  });
});
