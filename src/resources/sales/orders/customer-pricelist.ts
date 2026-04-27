/**
 * Customer → Pricelist resolution.
 *
 * Reads the customer's `priceListId` so the order pipeline can apply
 * negotiated B2B / wholesale pricing during line snapshot resolution.
 *
 * Customers are intentionally NOT branch-scoped (see
 * `customer.resource.ts:tenantField: false`) — the same person can buy
 * from any branch. Lookup is by `_id` only.
 *
 * Returns `null` (no pricelist) for any failure mode:
 *   - no customerId on the order (guest checkout)
 *   - customerId not a valid ObjectId
 *   - customer not found
 *   - customer has no `priceListId`
 *
 * Failure-mode = no-op falls cleanly back to the product's base price
 * (the snapshot path used to do this for every order before pricelist
 * was wired through).
 */

import mongoose from 'mongoose';
import Customer from '#resources/sales/customers/customer.model.js';

export interface PricelistResolution {
  /** The pricelist id (string-stringified ObjectId) to apply to this order. */
  priceListId: string;
  /** Customer id we resolved against — useful for log breadcrumbs. */
  customerId: string;
}

/**
 * Resolve the active pricelist for the order's customer.
 *
 * Accepts the order body's `customer` block as it appears in
 * `placement.service.ts`: `{ _id?: string; email?: string; ... }`. Only
 * the `_id` is consulted — guest orders without a customer record (no
 * `_id`) skip the lookup and use base price.
 *
 * The `_organizationId` parameter is accepted for forward compatibility
 * (e.g. if customers ever become branch-scoped) but currently unused.
 */
export async function resolveCustomerPriceList(
  customerRef: { _id?: string; email?: string } | undefined,
  _organizationId?: string,
): Promise<PricelistResolution | null> {
  const customerId = customerRef?._id;
  if (!customerId) return null;
  if (!mongoose.Types.ObjectId.isValid(customerId)) return null;

  const customer = (await Customer.findOne({
    _id: new mongoose.Types.ObjectId(customerId),
  })
    .select({ _id: 1, priceListId: 1 })
    .lean()) as { _id: unknown; priceListId?: unknown } | null;

  if (!customer?.priceListId) return null;

  return {
    priceListId: String(customer.priceListId),
    customerId,
  };
}
