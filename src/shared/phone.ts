/**
 * Phone normalization — single source of truth for E.164 on the backend.
 *
 * The frontend's <PhoneInput> nudges the shape toward `+{dialCode}{digits}`
 * but the server cannot trust that: non-browser clients (mobile, partner
 * API, guest checkout curl, agentic buyers) can send any string. We re-parse
 * every phone through `libphonenumber-js` and persist the canonical E.164
 * form so `findOrCreateByPhone` dedupes across format variants like
 * `01711000001`, `+8801711000001`, `+880 1711-000-001`.
 *
 * Two helpers:
 *   - `normalizePhone(raw, { defaultCountry })` — strict. Returns the E.164
 *     string or throws `PhoneFormatError` on unparseable / invalid input.
 *   - `tryNormalizePhone(raw, options)` — returns `null` instead of throwing;
 *     for code paths where a malformed phone is skipped rather than rejected.
 *
 * `defaultCountry` is the ISO 3166-1 alpha-2 code applied when the input has
 * no explicit country code (e.g. a BD shopper typing `01711000001` on a BD
 * storefront). Defaults to `'BD'` — the deployment's primary market.
 */

import { type CountryCode, isValidPhoneNumber, parsePhoneNumberWithError } from 'libphonenumber-js';

export class PhoneFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhoneFormatError';
  }
}

export interface NormalizePhoneOptions {
  /** ISO-3166-1 alpha-2 country code used when the input has no country prefix. */
  defaultCountry?: CountryCode;
}

/**
 * Parse and return the canonical E.164 representation. Throws on invalid
 * input so callers at request boundaries surface a 400 to the user.
 */
export function normalizePhone(raw: string, options: NormalizePhoneOptions = {}): string {
  const defaultCountry = options.defaultCountry ?? 'BD';
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new PhoneFormatError('phone is required');

  try {
    const parsed = parsePhoneNumberWithError(trimmed, defaultCountry);
    if (!parsed.isValid()) {
      throw new PhoneFormatError(`phone is not a valid ${defaultCountry} number`);
    }
    return parsed.number; // E.164, e.g. "+8801711000001"
  } catch (err) {
    if (err instanceof PhoneFormatError) throw err;
    throw new PhoneFormatError('phone is malformed');
  }
}

/**
 * Non-throwing variant — useful for best-effort cleanup of legacy data or
 * fields where a malformed phone should be silently dropped.
 */
export function tryNormalizePhone(raw: string | undefined | null, options: NormalizePhoneOptions = {}): string | null {
  if (!raw) return null;
  try {
    return normalizePhone(raw, options);
  } catch {
    return null;
  }
}

/** Thin re-export so callers don't need to import the library directly. */
export function isPhoneValid(raw: string, defaultCountry: CountryCode = 'BD'): boolean {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return false;
  return isValidPhoneNumber(trimmed, defaultCountry);
}
