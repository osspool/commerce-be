/**
 * Display-label helpers for posting contracts.
 *
 * Every contract feeds the JE-level `label` to the General Ledger UI. Raw
 * Mongo ObjectIds (24 chars) and timestamp concats are unsuitable for
 * display — we want document numbers (`ORD-2026-04-1234`), partner names
 * (`Acme Industries`), or, when none is available, a short tail of the id
 * so the operator can still cross-reference (`…b8b7e406`).
 *
 * `displayRef` is the shared accessor — every contract uses it instead of
 * inlining the same fallback chain. Keeps the antipattern from drifting
 * back in next time someone copies an existing contract for a new event.
 */

/**
 * Pick the best display fragment for a JE label.
 *
 * Resolution order:
 *   1. `referenceNumber` — explicit human-readable reference
 *      (document number, partner name, SKU, etc.)
 *   2. `…{last 8 chars}` of the id — last-resort, but at least readable
 *      and usable for cross-reference in the source collection.
 *
 * Always returns a non-empty string so callers can build a label without
 * conditional branches.
 *
 * @example
 *   label: `COGS — Order ${displayRef(data.orderReferenceNumber, data.orderId)}`
 *   // Output: "COGS — Order ORD-2026-04-1234"   (with referenceNumber)
 *   //      or "COGS — Order …b8b7e406"           (without)
 */
export function displayRef(referenceNumber: string | undefined | null, id: string): string {
  if (referenceNumber && referenceNumber.trim().length > 0) {
    return referenceNumber.trim();
  }
  if (id.length <= 8) return id;
  return `…${id.slice(-8)}`;
}

/**
 * Same idea, but for partner-style ids where the fallback is even less
 * useful (`…b8b7e406` from a customer ObjectId tells the operator nothing).
 *
 * Resolution order:
 *   1. `name` — partner display name (`Acme Industries`)
 *   2. `…{last 8 chars}` of the id, prefixed with the kind (`Customer
 *      …b8b7e406`) so the operator at least knows which directory to look
 *      in if they really need to chase the id down.
 */
export function displayPartner(
  name: string | undefined | null,
  id: string,
  kind: 'Customer' | 'Supplier' | 'Partner' = 'Partner',
): string {
  if (name && name.trim().length > 0) {
    return name.trim();
  }
  if (id.length <= 8) return `${kind} ${id}`;
  return `${kind} …${id.slice(-8)}`;
}
