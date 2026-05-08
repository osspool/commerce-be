/**
 * Customer-name normalisation helpers.
 *
 * Pure, side-effect-free string utilities that turn the messy "what arrived
 * at the auth / POS / checkout boundary" into the structured `PersonName`
 * the customer model stores. Extracted from `customer.repository.ts` so the
 * heuristics are unit-testable in isolation (no Mongoose, no DB).
 */

import type { PersonName } from '@classytic/primitives/person';

/**
 * Does this `PersonName` carry at least one usable, non-empty name part?
 *
 * Used by both the customer-model virtuals (`fullName` / `displayName`) and
 * any code path that needs to decide "is this customer effectively unnamed".
 * Defends against the legacy data shape and any future write that lands an
 * all-empty `{ given: '', family: '' }`. Without this, `formatDisplayName`
 * from `@classytic/primitives` returns the literal string `"undefined
 * undefined"` for empty names — a bug we've patched at the write boundary
 * but keep guarding at the read boundary too (defense in depth).
 */
export function hasUsableName(name: PersonName | undefined | null): boolean {
  if (!name) return false;
  return Boolean(
    name.preferred?.trim() ||
      name.given?.trim() ||
      name.family?.trim() ||
      name.middle?.trim() ||
      name.prefix?.trim() ||
      name.suffix?.trim(),
  );
}

/**
 * Detect a "looks like an identifier, not a person name" string.
 *
 * Better Auth signs OAuth users in with `user.name` populated from the
 * provider — but Apple-private-relay / Google-custom-name flows (and our
 * own guest-checkout fallback) sometimes put the BA `user.id` string into
 * `user.name`. That id is a 20-char base64-url-safe nanoid like
 * `gcqAUBgGpRnDZbyPgKbS`, and storing it as `name.given` leaks the
 * internal id into the dashboard customers table.
 *
 * Heuristic (cheap, no false-positives observed on real BD names):
 *   - 12+ chars
 *   - no whitespace (real "full names" have spaces; single-name locales
 *     are usually < 12 chars: "Sadman", "Nirjhar", "Subarna", etc.)
 *   - at least 3 uppercase AND 3 lowercase letters (Title-Case names
 *     don't qualify — "Sadman Chowdhury" has 2 uppercase chars; even
 *     the longest single Bangla romanisation rarely hits 3+ uppercase
 *     in one token)
 *   - OR a bare 24-char lowercase hex (ObjectId)
 *
 * If a real name ever gets misclassified, the customer can edit it from
 * the profile page and the heuristic only runs at create / link time.
 */
export function looksLikeIdentifierNotName(value: string): boolean {
  if (!value) return false;
  if (/^[a-f0-9]{24}$/.test(value)) return true; // bare ObjectId
  if (value.length < 12) return false;
  if (/\s/.test(value)) return false;
  const upper = (value.match(/[A-Z]/g) ?? []).length;
  const lower = (value.match(/[a-z]/g) ?? []).length;
  return upper >= 3 && lower >= 3;
}

/**
 * Pick a display fallback when `user.name` is missing or token-like.
 * Prefers the email local-part (capitalised) so customers see a recognisable
 * label in the dashboard instead of "Unknown" or a leaked id.
 */
export function fallbackNameFromUser(
  user: { name?: string; email?: string },
  defaultLabel: string,
): string {
  const email = user.email?.trim();
  if (email && email.includes('@')) {
    const local = email.split('@', 1)[0];
    // Strip non-alpha noise + tokenise on common separators ("." "_" "+" "-").
    const cleaned = local.replace(/[^a-zA-Z]+/g, ' ').trim();
    if (cleaned.length >= 2) {
      return cleaned
        .split(/\s+/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join(' ');
    }
  }
  return defaultLabel;
}

/**
 * Sanitize a display-name string before it gets snapshotted into a
 * derivative collection (order, invoice, shipment, transaction, etc.).
 *
 * The customer-creation boundary (`customer.repository.ts`) already
 * scrubs token-shaped names. This helper is the second line of defence
 * for write paths that copy `customer.name` somewhere else — if the
 * source ever regressed, the snapshot still wouldn't carry the leak.
 *
 * Returns:
 *   - the trimmed input when it's a real-looking name
 *   - `fallback` when the input is empty, undefined, or token-shaped
 *
 * Caller is responsible for picking a sensible `fallback` (e.g. the
 * email local-part, "Customer", "Walk-in", etc.).
 */
export function sanitizeDisplayName(value: string | undefined | null, fallback: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return fallback;
  if (looksLikeIdentifierNotName(trimmed)) return fallback;
  return trimmed;
}

/**
 * Split a flat "Full Name" string into a structured `PersonName`.
 *
 * Callers at the auth / POS boundary pass flat names; storage is structured.
 * Single-token names go in `given` with an empty `family` (many BD and
 * single-name locales store a single name, which is valid).
 *
 * `user` (optional) supplies an `email` so we can derive a sensible display
 * fallback when the input is empty or looks like a BA user id rather than
 * a real name. Without `user`, the static `fallback` arg is the floor.
 */
export function nameFromString(
  flat: string | undefined,
  fallback: string,
  user?: { name?: string; email?: string },
): PersonName {
  const trimmed = (flat ?? '').trim();
  const isUsable = trimmed && !looksLikeIdentifierNotName(trimmed);
  const source = isUsable ? trimmed : user ? fallbackNameFromUser(user, fallback) : fallback;
  const parts = source.split(/\s+/);
  if (parts.length <= 1) return { given: parts[0] ?? fallback, family: '' };
  const family = parts.pop() ?? '';
  return { given: parts.join(' '), family };
}
