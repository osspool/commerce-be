// src/config/utils.ts
import { arcLog } from '@classytic/arc/logger';

const log = arcLog('config-utils');

/**
 * Parses a value as a boolean (case-insensitive 'true').
 */
export function parseBoolean(value: string | undefined | null): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value).toLowerCase() === 'true';
}

/**
 * Parses a value as an integer, with a default fallback.
 */
export function parseIntEnv(value: string | undefined | null, defaultValue: number): number {
  if (value === undefined || value === null) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Parses a delimited string into an array of trimmed strings.
 */
export function parseDelimitedString(value: string | undefined | null, delimiter: string = ','): string[] {
  if (!value) return [];
  return value
    .split(delimiter)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Checks if a required environment variable is set. Throws an error instead of exiting.
 */
export function requiredEnv(envVar: string): string {
  if (!process.env[envVar]) {
    const errorMsg = `Required environment variable ${envVar} is missing.`;
    log.error(errorMsg);
    throw new Error(errorMsg);
  }
  return process.env[envVar] as string;
}

/**
 * Logs a warning if a sensitive (optional but recommended) environment variable is missing.
 */
export function warnIfMissing(envVar: string): void {
  if (!process.env[envVar]) {
    log.warn(`${envVar} is not set. Functionality related to this variable may not work.`);
  }
}
