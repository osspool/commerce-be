/**
 * Bangladesh Date Utilities
 *
 * BD timezone = UTC+6 (Asia/Dhaka).
 * Accounting dates must always be in BD local time so that a 11:55 PM sale
 * in Dhaka goes into today's entry, not UTC tomorrow.
 */

const BD_OFFSET_MS = 6 * 60 * 60 * 1000; // UTC+6

/**
 * Get the BD local date string (YYYY-MM-DD) for a UTC timestamp.
 * Defaults to now.
 */
export function toBdDateStr(utcDate?: Date | string): string {
  const d = utcDate ? new Date(utcDate) : new Date();
  const bdMs = d.getTime() + BD_OFFSET_MS;
  return new Date(bdMs).toISOString().split('T')[0];
}

/**
 * Get the BD start-of-day as UTC Date for a YYYY-MM-DD string.
 * e.g. "2024-01-15" → 2024-01-14T18:00:00.000Z (midnight BD = 18:00 UTC)
 */
export function bdDayStartUtc(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000+06:00`);
}

/**
 * Get the BD end-of-day as UTC Date for a YYYY-MM-DD string.
 */
export function bdDayEndUtc(dateStr: string): Date {
  return new Date(`${dateStr}T23:59:59.999+06:00`);
}

/**
 * Returns yesterday's date string in BD time.
 */
export function bdYesterday(): string {
  const d = new Date(Date.now() - BD_OFFSET_MS - 24 * 60 * 60 * 1000);
  return new Date(d.getTime() + BD_OFFSET_MS).toISOString().split('T')[0];
}

/**
 * Returns today's date string in BD time.
 */
export function bdToday(): string {
  return toBdDateStr();
}

/**
 * Returns the next day after a BD date string.
 * e.g. "2024-01-15" → "2024-01-16"
 */
export function nextBdDate(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00.000Z`); // noon to avoid DST edge
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split('T')[0];
}
