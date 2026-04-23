/**
 * Pure parsers for report query-string inputs.
 *
 * Kept as standalone functions so unit tests can hit them without
 * booting Flow or Fastify — see tests/report.utils.test.ts.
 */

const DEFAULT_BUCKETS = [30, 60, 90];

/**
 * Parse "30,60,90" → [30, 60, 90]. Sorts ascending, drops non-positive
 * and non-numeric values, falls back to DEFAULT_BUCKETS when undefined,
 * empty, or fully invalid.
 */
export function parseBuckets(raw: string | undefined): number[] {
  if (!raw) return [...DEFAULT_BUCKETS];
  const parsed = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  return parsed.length > 0 ? parsed : [...DEFAULT_BUCKETS];
}

/**
 * Parse "a, b ,c" → ["a","b","c"]. Trims, dedupes, drops empties.
 * Returns [] when undefined.
 */
export function parseSkuRefs(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Turnover lookback days: floors to integer, falls back to `fallback`
 * (default 30) for undefined / non-positive / non-numeric input.
 */
export function parsePeriodDays(raw: string | undefined, fallback = 30): number {
  if (!raw) return fallback;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}
