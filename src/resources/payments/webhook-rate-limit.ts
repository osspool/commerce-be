/**
 * Payment webhook rate-limit config.
 *
 * Payment providers retry on 5xx, so the limit must fit normal bursts plus a
 * few retries. 60/min is generous for real traffic and caps abuse from a
 * spoofed endpoint hammered by scanners. Disabled under NODE_ENV=test so
 * integration suites can replay webhooks from one IP without tripping it.
 */
export type WebhookRateLimit = { max: number; timeWindow: string } | false;

export function buildWebhookRateLimit(): WebhookRateLimit {
  // Tests can force-enable the limit to assert 429 behavior.
  if (process.env.NODE_ENV === 'test' && process.env.RATE_LIMIT_ENABLED !== 'true') return false;
  const max = Number(process.env.RATE_LIMIT_MAX ?? 60);
  const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
  return { max, timeWindow: `${windowMs}ms` };
}
