import { describe, it, expect, afterEach } from 'vitest';
import { buildWebhookRateLimit } from '../../src/resources/payments/webhook-rate-limit.js';

describe('buildWebhookRateLimit', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('returns false in NODE_ENV=test so integration suites do not trip the limit', () => {
    process.env.NODE_ENV = 'test';
    expect(buildWebhookRateLimit()).toBe(false);
  });

  it('returns a tight per-IP limit in production', () => {
    process.env.NODE_ENV = 'production';
    const result = buildWebhookRateLimit();
    expect(result).not.toBe(false);
    if (result === false) throw new Error('unreachable');
    expect(result.max).toBeGreaterThan(0);
    expect(result.max).toBeLessThanOrEqual(120);
    // Accept either human-readable ("1 minute") or ms-suffixed ("60000ms") —
    // @fastify/rate-limit parses both, and the test suite toggles between
    // them via RATE_LIMIT_WINDOW_MS overrides.
    expect(result.timeWindow).toMatch(/minute|second|ms$/);
  });

  it('returns a limit in non-test, non-prod (dev/staging)', () => {
    process.env.NODE_ENV = 'dev';
    const result = buildWebhookRateLimit();
    expect(result).not.toBe(false);
  });
});
