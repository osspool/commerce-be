/**
 * notification-payment-failure — unit test (gap #16)
 *
 * Validates that NOTIFICATION_TRIGGERS includes a trigger for
 * `order:payment.state_updated` that fires ONLY when chargeStatus === 'failed'.
 *
 * RED: fails until the trigger is added to notification.triggers.ts
 * GREEN: add the trigger entry
 */

import { describe, it, expect } from 'vitest';
import {
  NOTIFICATION_TRIGGERS,
  getTriggerByEvent,
} from '../../src/resources/notifications/notification.triggers.js';

const PAYMENT_STATE_UPDATED = 'order:payment.state_updated';

describe('notification trigger — payment failure (gap #16)', () => {
  it('has a trigger registered for order:payment.state_updated', () => {
    const trigger = getTriggerByEvent(PAYMENT_STATE_UPDATED);
    expect(trigger, `Expected a trigger for '${PAYMENT_STATE_UPDATED}' in NOTIFICATION_TRIGGERS`).toBeDefined();
  });

  it('trigger type is payment:failed to distinguish from other payment state updates', () => {
    const trigger = getTriggerByEvent(PAYMENT_STATE_UPDATED);
    expect(trigger?.type).toBe('payment:failed');
  });

  it('extract returns null when chargeStatus is not failed (no notification spam)', () => {
    const trigger = getTriggerByEvent(PAYMENT_STATE_UPDATED);
    expect(trigger).toBeDefined();

    const nonFailedStatuses = ['none', 'partial', 'full', 'refunded', 'processing'];
    for (const chargeStatus of nonFailedStatuses) {
      const result = trigger!.extract({
        organizationId: 'org-123',
        orderNumber: 'ORD-001',
        paymentState: { chargeStatus },
      });
      expect(result, `extract should return null for chargeStatus='${chargeStatus}'`).toBeNull();
    }
  });

  it('extract returns variables when chargeStatus is failed', () => {
    const trigger = getTriggerByEvent(PAYMENT_STATE_UPDATED);
    expect(trigger).toBeDefined();

    const result = trigger!.extract({
      organizationId: 'org-abc',
      orderNumber: '#ORD-999',
      orderId: 'order-doc-id',
      paymentState: { chargeStatus: 'failed', failureReason: 'Insufficient funds' },
    });

    expect(result).not.toBeNull();
    expect(result?.organizationId).toBe('org-abc');
    expect(result?.variables.orderNumber).toBe('#ORD-999');
    expect(result?.variables.reason).toBeTruthy();
  });

  it('priority is high (payment failures need immediate attention)', () => {
    const trigger = getTriggerByEvent(PAYMENT_STATE_UPDATED);
    expect(trigger?.priority).toBe('high');
  });
});
