/**
 * Sales configuration — customer-channel routing settings.
 *
 * Keep this narrow: only host-level flags that change how incoming orders
 * are routed, scoped, or stamped. Per-order business data lives on the
 * order document; per-repo wiring lives in `order.engine.ts`.
 *
 * ### E-commerce fulfillment branch
 * Owned by the operator via the Branches admin UI — a branch with
 * `fulfillsEcommerce: true` (or the legacy `type: 'ecommerce'`). See
 * `#resources/sales/orders/ecom-branch.ts#getEcomBranchId`. Deliberately
 * NOT configurable via env — a runtime DB flag is the right granularity
 * for a setting operators need to flip without redeploying.
 */

export interface SalesConfigSection {
  sales: {
    /**
     * Whether `POST /orders/guest/place` accepts anonymous submissions.
     * Defaults to `true` — flip off by setting `GUEST_CHECKOUT=false` if a
     * deployment wants to force sign-in before checkout.
     */
    guestCheckoutEnabled: boolean;

    /**
     * ISO 3166-1 alpha-2 country code used to interpret national-format
     * phone numbers when the caller omits a country prefix (`01711000001`
     * → `+8801711000001` for `BD`). Full E.164 input is unaffected. Set
     * via `DEFAULT_PHONE_COUNTRY`; defaults to `BD`.
     */
    defaultPhoneCountry: string;
  };
}

function parseBoolDefaultTrue(value: string | undefined): boolean {
  if (value === undefined) return true;
  return !['false', '0', 'no', 'off'].includes(value.toLowerCase());
}

const salesConfig: SalesConfigSection = {
  sales: {
    guestCheckoutEnabled: parseBoolDefaultTrue(process.env.GUEST_CHECKOUT),
    defaultPhoneCountry: (process.env.DEFAULT_PHONE_COUNTRY ?? 'BD').toUpperCase(),
  },
};

export default salesConfig;
