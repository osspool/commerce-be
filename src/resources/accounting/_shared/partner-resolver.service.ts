/**
 * Partner Resolver — id+type → display name, batched.
 *
 * The ledger kernel emits raw `partnerId` (ObjectId string) on journal items;
 * it has no concept of Customer / Supplier models. Every accounting surface
 * that exposes partner-keyed rows to the UI (aging reports, open A/R, open
 * A/P, partner statements) needs the same join: look up the right host model
 * by `partnerType` and substitute a display name.
 *
 * Before this primitive existed each report rolled its own (or skipped the
 * lookup entirely — A/R Aging shipped showing "4bf45c09" partial ObjectIds).
 * `decorateWithPartnerNames` is the single canonical way to enrich those
 * rows. Two batched queries — one against Customer, one against Supplier —
 * regardless of input size, so report endpoints stay O(1) in DB roundtrips.
 *
 * Naming uses the canonical fallback chain:
 *   Customer: `displayName` → `formatDisplayName(name)` → `null`
 *   Supplier: `name` (flat string) → `null`
 *
 * Pure service module — no HTTP, no Arc dependency. Caller decides where to
 * splice the result into a route response.
 */

import { formatDisplayName, type PersonName } from '@classytic/primitives/person';
import mongoose from 'mongoose';
import Customer from '../../sales/customers/customer.model.js';
import Supplier from '../../inventory/supplier/models/supplier.model.js';

export type PartnerType = 'customer' | 'supplier';

export interface PartnerRef {
  partnerId?: string | mongoose.Types.ObjectId | null;
  partnerType?: PartnerType | null;
}

export interface PartnerName {
  partnerId: string;
  partnerType: PartnerType;
  partnerName: string;
}

/**
 * Resolve partnerId → display name. Returns a Map keyed by stringified id.
 *
 * `defaultSide` is consulted when an input row lacks `partnerType` (legacy
 * data + reports that don't carry the side). When a row has neither
 * `partnerType` nor `defaultSide`, the id is queried against BOTH models —
 * Customer wins on collision (rare in practice; ids are ObjectIds).
 */
export async function resolvePartnerNames(
  refs: readonly PartnerRef[],
  defaultSide?: PartnerType,
): Promise<Map<string, string>> {
  const customerIds = new Set<string>();
  const supplierIds = new Set<string>();

  for (const ref of refs) {
    if (!ref.partnerId) continue;
    const id = String(ref.partnerId);
    const side = ref.partnerType ?? defaultSide ?? null;
    if (side === 'customer') customerIds.add(id);
    else if (side === 'supplier') supplierIds.add(id);
    else {
      // Unknown side: probe both models — same id can't be in both
      // (different ObjectId pools), so this is a low-cost belt-and-braces.
      customerIds.add(id);
      supplierIds.add(id);
    }
  }

  const [customers, suppliers] = await Promise.all([
    customerIds.size
      ? Customer.find({ _id: { $in: [...customerIds] } })
          .select('_id displayName name')
          .lean()
      : Promise.resolve([]),
    supplierIds.size
      ? Supplier.find({ _id: { $in: [...supplierIds] } })
          .select('_id name')
          .lean()
      : Promise.resolve([]),
  ]);

  const map = new Map<string, string>();
  for (const c of customers as Array<{ _id: unknown; displayName?: string; name?: PersonName }>) {
    const display =
      c.displayName?.trim() ||
      (c.name ? formatDisplayName(c.name) : '') ||
      '';
    if (display) map.set(String(c._id), display);
  }
  for (const s of suppliers as Array<{ _id: unknown; name?: string }>) {
    if (s.name?.trim()) map.set(String(s._id), s.name.trim());
  }
  return map;
}

/**
 * Decorate a list of rows with `partnerName` joined from Customer/Supplier.
 *
 * Mutation-free — returns new objects. `partnerName` is `null` when the id
 * is missing or unresolvable (DB row was deleted, partner archived, etc.).
 * Reports should render `null` as "—" or similar placeholder, never crash.
 */
export async function decorateWithPartnerNames<T extends PartnerRef>(
  rows: readonly T[],
  defaultSide?: PartnerType,
): Promise<Array<T & { partnerName: string | null }>> {
  const map = await resolvePartnerNames(rows, defaultSide);
  return rows.map((row) => ({
    ...row,
    partnerName: row.partnerId ? map.get(String(row.partnerId)) ?? null : null,
  }));
}

/**
 * Resolve partner names on rows where the id lives in a NESTED path —
 * e.g. aging report rows where the contact dimension is reported as
 * `{ contactId: '...', contactType: 'customer' }` rather than at the top
 * level. Pass the path getters and we'll do the same batched lookup.
 */
export async function decorateNestedPartnerNames<T>(
  rows: readonly T[],
  getId: (row: T) => string | mongoose.Types.ObjectId | null | undefined,
  getType: (row: T) => PartnerType | null | undefined,
  defaultSide?: PartnerType,
): Promise<Array<T & { partnerName: string | null }>> {
  const refs: PartnerRef[] = rows.map((r) => ({
    partnerId: getId(r),
    partnerType: getType(r) ?? null,
  }));
  const map = await resolvePartnerNames(refs, defaultSide);
  return rows.map((row) => {
    const id = getId(row);
    return {
      ...row,
      partnerName: id ? map.get(String(id)) ?? null : null,
    };
  });
}
