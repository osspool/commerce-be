/**
 * Translate the checkout / POS shipping-address shape into the canonical
 * shape `@classytic/order`'s Fulfillment schema expects.
 *
 * The FE form + SDK type carry a BD-retail shape optimized for the UI:
 *
 *   { recipientName, recipientPhone, addressLine1, addressLine2,
 *     areaId, areaName, zoneId, city, division, postalCode, country,
 *     providerAreaIds, pathaoCityId, pathaoZoneId, ... }
 *
 * The kernel's `addressSchema` (packages/order/src/models/fulfillment.model.ts)
 * is strict and requires `{ name, line1, city, country }` plus optional
 * `{ line2, state, postalCode, phone }`. Extra keys (areaId, zoneId,
 * pathaoCityId, ...) are silently stripped on save.
 *
 * Before this helper existed, placement.service and pos.controller both
 * passed the FE shape straight through, so `createForOrder` threw a
 * Mongoose validation error — `line1: Path 'line1' is required`. The
 * placement path wrapped it in a best-effort try/catch, so the failure
 * only surfaced as a warn log while fulfillments silently never got
 * created. Every downstream flow (logistics shipment, Pathao CSV export,
 * shipment tracking) then saw "no fulfillment" and couldn't ship.
 *
 * This helper is the one place the translation happens. Keeping it here
 * (rather than inlining in each caller) means a future address schema
 * change in `@classytic/order` is one edit.
 *
 * NOTE on routing IDs: the carrier routing ids (`pathaoCityId`,
 * `pathaoZoneId`, `providerAreaIds`, `areaId`) are NOT on the canonical
 * schema today. The Pathao CSV export falls back to name matching when
 * they're missing. If those IDs need to round-trip, the right fix is to
 * add a `providerRefs: Mixed` sub-field to `addressSchema` in the order
 * package — out of scope for this translator.
 */

export interface FeShippingAddress {
  recipientName?: string;
  recipientPhone?: string;
  addressLine1?: string;
  addressLine2?: string;
  line1?: string; // already-canonical callers pass through cleanly
  line2?: string;
  name?: string;
  phone?: string;
  city?: string;
  state?: string;
  division?: string;
  postalCode?: string;
  country?: string;
  // BD routing fields — preserved verbatim if present.
  areaId?: number;
  areaName?: string;
  zoneId?: number;
  // Provider-specific refs. Example shape:
  //   { pathao: { cityId, zoneId }, redx: { areaId }, ... }
  // FE sometimes sends under `providerAreaIds` — we accept both names.
  providerRefs?: Record<string, unknown>;
  providerAreaIds?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CanonicalFulfillmentAddress {
  name?: string;
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode?: string;
  country: string;
  phone?: string;
  areaId?: number;
  areaName?: string;
  zoneId?: number;
  providerRefs?: Record<string, unknown>;
}

/**
 * Map a caller-supplied shipping address onto the canonical fulfillment
 * address shape. Returns `null` when the result would be unusable — the
 * fulfillment schema's required fields (`line1`, `city`, `country`) are
 * missing — so callers can skip the createForOrder call cleanly instead
 * of letting mongoose throw later.
 *
 * Resolution rules:
 *   - `line1`  ← addressLine1  (FE) OR line1 (already canonical)
 *   - `name`   ← recipientName OR name
 *   - `phone`  ← recipientPhone OR phone
 *   - `state`  ← state OR division (BD retail uses divisions, mapped here)
 *   - `country` ← country OR 'Bangladesh' (default — this is a BD-only
 *                  deployment; explicit country wins if caller set it)
 *
 * Every FE-shape field maps verbatim when already canonical. POS + storefront
 * can both send the FE shape without caring about the mapping.
 */
export function toFulfillmentAddress(
  input: FeShippingAddress | null | undefined,
): CanonicalFulfillmentAddress | null {
  if (!input || typeof input !== 'object') return null;

  const line1 = (input.addressLine1 ?? input.line1)?.toString().trim();
  const city = input.city?.toString().trim();
  const country = (input.country?.toString().trim() || 'Bangladesh');

  // Required-field gate. Missing any of these means the fulfillment
  // can't be created. Caller should treat `null` as "skip, warn, admin
  // will fix it later" — same semantics as the placement pipeline's
  // best-effort fulfillment block.
  if (!line1 || !city || !country) return null;

  const canonical: CanonicalFulfillmentAddress = {
    line1,
    city,
    country,
  };

  const name = (input.recipientName ?? input.name)?.toString().trim();
  if (name) canonical.name = name;

  const phone = (input.recipientPhone ?? input.phone)?.toString().trim();
  if (phone) canonical.phone = phone;

  const line2 = (input.addressLine2 ?? input.line2)?.toString().trim();
  if (line2) canonical.line2 = line2;

  // BD addresses use "division" as the top-level admin region. Map that
  // to the schema's generic `state` so reports + carrier adapters that
  // read `state` work without each having its own BD-special-case.
  const state = (input.state ?? input.division)?.toString().trim();
  if (state) canonical.state = state;

  const postalCode = input.postalCode?.toString().trim();
  if (postalCode) canonical.postalCode = postalCode;

  // BD routing — preserve verbatim. The kernel schema accepts these as
  // optional top-level fields (areaId, areaName, zoneId) plus a Mixed
  // `providerRefs` bag for per-carrier ids. Carrier adapters + the
  // Pathao CSV export read these when present and fall back to name
  // matching when they're not.
  if (typeof input.areaId === 'number') canonical.areaId = input.areaId;
  if (typeof input.areaName === 'string' && input.areaName.trim()) {
    canonical.areaName = input.areaName.trim();
  }
  if (typeof input.zoneId === 'number') canonical.zoneId = input.zoneId;

  // Accept either `providerRefs` (canonical) or `providerAreaIds` (the FE
  // form key today). Merging into a single `providerRefs` on the kernel
  // doc — one less name for downstream readers to remember.
  const refs = input.providerRefs ?? input.providerAreaIds;
  if (refs && typeof refs === 'object' && Object.keys(refs).length > 0) {
    canonical.providerRefs = refs as Record<string, unknown>;
  }

  return canonical;
}
