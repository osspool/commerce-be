/**
 * Pure helpers for inventory report query parsing.
 * Kept free of Fastify/Flow imports so they can be unit-tested in isolation.
 */

const DEFAULT_BUCKETS = [30, 60, 90] as const;

/** Parse `?buckets=30,60,90` into a sorted positive-integer array. Falls back to defaults. */
export function parseBuckets(raw: string | undefined): number[] {
  if (!raw) return [...DEFAULT_BUCKETS];
  const parsed = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parsed.length > 0 ? parsed.sort((a, b) => a - b) : [...DEFAULT_BUCKETS];
}

/** Parse `?skuRefs=a,b,c` into a deduped array. Empty/undefined → []. */
export function parseSkuRefs(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
}

/** Parse `?periodDays=30` into a positive integer. Defaults to 30. */
export function parsePeriodDays(raw: string | undefined, fallback = 30): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
