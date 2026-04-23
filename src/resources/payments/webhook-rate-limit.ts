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
  if (process.env.NODE_ENV === 'test') return false;
  return { max: 60, timeWindow: '1 minute' };
}
