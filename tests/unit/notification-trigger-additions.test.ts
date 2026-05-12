/**
 * Notification trigger additions — unit test (MAJOR gaps)
 *
 * Gaps:
 *   - No loyalty point-expiry warning (N days before)
 *   - No low-stock escalation (unresolved stock:low → purchase manager)
 *
 * Fix: Two new triggers added to NOTIFICATION_TRIGGERS in notification.triggers.ts
 *
 * RED: loyalty:points_expiring and stock:low_escalation triggers absent
 * GREEN: both triggers registered with correct event names, types, and recipients
 */

import { describe, it, expect } from 'vitest';

describe('Notification trigger additions', () => {
  it('loyalty.points.expiring_soon trigger is registered', async () => {
    const { NOTIFICATION_TRIGGERS } = await import(
      '../../src/resources/notifications/notification.triggers.js'
    );
    const trigger = NOTIFICATION_TRIGGERS.find((t) => t.event === 'loyalty.points.expiring_soon');
    expect(trigger).toBeDefined();
    expect(trigger?.type).toBe('loyalty:points_expiring');
    expect(trigger?.recipients).toContain('admin');
  });

  it('loyalty.points.expiring_soon extract returns null without organizationId', async () => {
    const { NOTIFICATION_TRIGGERS } = await import(
      '../../src/resources/notifications/notification.triggers.js'
    );
    const trigger = NOTIFICATION_TRIGGERS.find((t) => t.event === 'loyalty.points.expiring_soon')!;
    const result = trigger.extract({ pointsExpired: 500 });
    expect(result).toBeNull();
  });

  it('loyalty.points.expiring_soon extract maps points from payload', async () => {
    const { NOTIFICATION_TRIGGERS } = await import(
      '../../src/resources/notifications/notification.triggers.js'
    );
    const trigger = NOTIFICATION_TRIGGERS.find((t) => t.event === 'loyalty.points.expiring_soon')!;
    const result = trigger.extract({ organizationId: 'org1', pointsExpired: 250, membersAffected: 5 });
    expect(result?.variables.points).toBe('250');
    expect(result?.organizationId).toBe('org1');
  });

  it('stock:low_escalation trigger is registered', async () => {
    const { NOTIFICATION_TRIGGERS } = await import(
      '../../src/resources/notifications/notification.triggers.js'
    );
    const trigger = NOTIFICATION_TRIGGERS.find((t) => t.type === 'stock:low_escalation');
    expect(trigger).toBeDefined();
    expect(trigger?.event).toBe('stock:low');
    expect(trigger?.priority).toBe('high');
    expect(trigger?.sendEmail).toBe(true);
    expect(trigger?.recipients).toContain('admin');
  });

  it('both stock:low triggers coexist (original + escalation)', async () => {
    const { NOTIFICATION_TRIGGERS } = await import(
      '../../src/resources/notifications/notification.triggers.js'
    );
    const stockTriggers = NOTIFICATION_TRIGGERS.filter((t) => t.event === 'stock:low');
    expect(stockTriggers.length).toBeGreaterThanOrEqual(2);
  });
});
