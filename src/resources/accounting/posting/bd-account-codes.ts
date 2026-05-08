/**
 * Host-policy aliases over the canonical BD chart codes.
 *
 * The chart-of-accounts facts live in `@classytic/ledger-bd` —
 * `BD_ACCOUNT_CODES` is the single source of truth for "what code
 * does the BD chart assign to which account". This file maps domain-
 * meaningful keys used by be-prod's posting contracts (`merchandise`,
 * `ar`, `taxPayable`, etc.) onto those canonical codes.
 *
 * Why a host-side layer over the package map:
 * 1. Some keys are host-policy decisions, not chart facts. A retail
 *    deployment defaults `merchandise → 1164 Trading Goods`; a
 *    manufacturer would override to `1163 Finished Goods`. The chart
 *    is the same; the host's "default inventory account" differs.
 * 2. Domain-meaningful key names (`BD.ar`, `BD.cash`) read better in
 *    posting contracts than `BD_ACCOUNT_CODES.AR` and let us add
 *    semantic aliases (e.g. `taxReceivable: BD_ACCOUNT_CODES.VAT_RECEIVABLE`)
 *    without leaking the chart's naming choices into every contract.
 *
 * Per `@classytic/ledger-bd` the keys here resolve to seeded accounts;
 * adding a new key here MUST be paired with adding a code in
 * `BD_ACCOUNT_CODES` upstream and an entry in `BD_ACCOUNT_TYPES`.
 */

import { BD_ACCOUNT_CODES } from '@classytic/ledger-bd';

export const BD = {
  // ── Cash & Bank ──────────────────────────────────────────────
  /**
   * 1113 — Cash at Bank (Current Account). Default destination for card,
   * bank-transfer, and COD-settlement receipts; default source for
   * vendor-payment outflows. Don't hardcode `"1113"` — the BD chart has
   * renumbered before (e.g. the 0.x → 1.x migration moved this from
   * 1112). Use this alias so a future renumber is one diff away.
   */
  cash: BD_ACCOUNT_CODES.CASH,
  /** 1111 — Cash in Hand (Petty Cash). Use for till / cashier holdings. */
  pettyCash: BD_ACCOUNT_CODES.PETTY_CASH,
  /**
   * 1126 — Mobile Money Merchant Clearing. bKash / Nagad / Rocket merchant
   * balances awaiting bank settlement — separate from 1122 (ATM/CDM cash)
   * and 1113 (current account) so each settles independently in reports.
   */
  mobileMoneyMerchant: BD_ACCOUNT_CODES.MOBILE_MONEY_MERCHANT,
  /**
   * 1125 — Gateway Clearing. Card / online payment proceeds held by the
   * payment processor (Stripe, SSLCommerz, ShurjoPay) until daily payout.
   * Posts here on customer payment; reconciles to `cash` (1113) via a
   * settlement entry when the payout arrives, with the gateway fee booked
   * separately. This mirrors how Stripe / Shopify Payments / Square do it
   * internally — direct-to-bank booking overstates cash by the in-flight
   * float (typically 1-3 days × daily volume).
   */
  gatewayClearing: BD_ACCOUNT_CODES.GATEWAY_CLEARING,
  /**
   * 1127 — COD Clearing. Cash with the courier (Pathao / RedX / Steadfast)
   * after delivery, before remittance to the merchant. Reserved for the
   * future-state COD flow that books here on placement instead of `ar`
   * (1141); today's COD path still uses `ar` and is reclassified at
   * settlement. Track under `BD.codClearing` only when the deployment
   * wants to separate "courier holding our money" from regular trade A/R.
   */
  codClearing: BD_ACCOUNT_CODES.COD_CLEARING,

  // ── Trade Receivables ────────────────────────────────────────
  ar: BD_ACCOUNT_CODES.AR,
  /** 1158 — Net amount due from marketplaces (Daraz/Chaldal/Pickaboo). */
  marketplaceReceivable: BD_ACCOUNT_CODES.MARKETPLACE_RECEIVABLE,
  /**
   * 1159 — Card-network chargeback / dispute receivable. Holds disputed
   * amount during the 30-90 day network resolution window. Recovered →
   * reverses to cash; lost → written off via `badDebt`.
   */
  chargebackReceivable: BD_ACCOUNT_CODES.CHARGEBACK_RECEIVABLE,
  /**
   * Used as the inter-branch receivable when consolidated reporting
   * needs explicit settlement balances per branch pair. For a typical
   * inter-branch transfer the clearing approach via `inventoryInTransit`
   * is sufficient — `interBranchReceivable` is reserved for cost-
   * allocation flows that explicitly track branch settlement.
   */
  interBranchReceivable: BD_ACCOUNT_CODES.INTER_BRANCH_RECEIVABLE,

  // ── VAT Receivables / Tax ─────────────────────────────────────
  taxReceivable: BD_ACCOUNT_CODES.VAT_RECEIVABLE,
  ait: BD_ACCOUNT_CODES.ADVANCE_INCOME_TAX,
  /**
   * 1153 — VDS Receivable. Output VAT withheld by a designated buyer (govt /
   * large corporate) and deposited to NBR on our behalf. Held until offset
   * against VAT Output Payable at monthly filing. Debit this at sale time.
   */
  vdsReceivable: BD_ACCOUNT_CODES.VDS_RECEIVABLE,
  vatCashBasisTransition: BD_ACCOUNT_CODES.VAT_CASH_BASIS_TRANSITION,

  // ── Inventory ────────────────────────────────────────────────
  rawMaterials: BD_ACCOUNT_CODES.RAW_MATERIALS,
  wip: BD_ACCOUNT_CODES.WIP,
  finishedGoods: BD_ACCOUNT_CODES.FINISHED_GOODS,

  /**
   * Default inventory account for stock movements (procurement, sales
   * COGS, transfers, adjustments, returns). BigBoss Commerce is a
   * trading business, so `merchandise` (1164) is the default.
   *
   * **Host-policy override hook:** a manufacturing deployment would
   * change this to `BD_ACCOUNT_CODES.FINISHED_GOODS` (1163) without
   * changing any posting contract. That's why this file exists.
   */
  merchandise: BD_ACCOUNT_CODES.MERCHANDISE,

  packingMaterials: BD_ACCOUNT_CODES.PACKING_MATERIALS,
  inventoryInTransit: BD_ACCOUNT_CODES.INVENTORY_IN_TRANSIT,

  // ── Accounts Payable ─────────────────────────────────────────
  ap: BD_ACCOUNT_CODES.AP,
  /**
   * 2122 — Sales / agent commission accrued (internal reps + external
   * agents). Booked when the sale closes; cleared on commission payout.
   */
  commissionPayable: BD_ACCOUNT_CODES.COMMISSION_PAYABLE,
  /**
   * 2162 — Reverse Logistics / Returns Processing Payable. 3PL handling
   * fee, reverse-courier, restocking, inspection costs accrued at RMA
   * receipt. Distinct from outbound freight payable.
   */
  reverseLogisticsPayable: BD_ACCOUNT_CODES.REVERSE_LOGISTICS_PAYABLE,
  /**
   * 2191 — Customer advance / pre-payment (IFRS 15 contract liability).
   * Pre-orders, deposits, milestone-billed services. Cleared to revenue
   * when the performance obligation completes.
   */
  customerAdvance: BD_ACCOUNT_CODES.CUSTOMER_ADVANCE,
  interBranchPayable: BD_ACCOUNT_CODES.INTER_BRANCH_PAYABLE,

  // ── Clearing Liabilities (ledger-bd 0.2.2+) ──────────────────
  grIrClearing: BD_ACCOUNT_CODES.GR_IR_CLEARING,
  transferCostClearing: BD_ACCOUNT_CODES.TRANSFER_COST_CLEARING,

  taxPayable: BD_ACCOUNT_CODES.VAT_OUTPUT_PAYABLE,
  /**
   * 2136 — VDS Payable. Amount we withhold from a supplier's payment and
   * must remit to NBR directly. Credited at receipt; debited when remitted
   * to NBR. Distinct from TDS (2135) — VDS is VAT-side, TDS is income-tax-side.
   */
  vdsPayable: BD_ACCOUNT_CODES.VDS_PAYABLE,

  // ── Revenue ─────────────────────────────────────────────────
  revenue: BD_ACCOUNT_CODES.SALES_REVENUE,
  /**
   * 4147 — Transport / Freight Revenue. Use when delivery is sold as a
   * separate line item ("Tk 60 delivery charge") rather than baked into
   * product price. The actual delivery cost flows through `freightOutward`
   * separately so per-channel margin stays visible.
   */
  transportRevenue: BD_ACCOUNT_CODES.TRANSPORT_REVENUE,
  /** 4159 — Courier / Delivery Service Revenue (own fleet billed to customer). */
  courierRevenue: BD_ACCOUNT_CODES.COURIER_REVENUE,
  /**
   * 4310 — Bad Debt Recovery. Booked when a previously written-off
   * receivable is unexpectedly recovered (chargeback reversal, late COD
   * remittance). Counterpart of `badDebt`.
   */
  badDebtRecovery: BD_ACCOUNT_CODES.BAD_DEBT_RECOVERY,

  // ── Other Income ─────────────────────────────────────────────
  /**
   * 4319 — Restocking fee retained on RMA confirms. Booked separately
   * from `revenue` so RMA monetisation (fee coverage of return-handling
   * cost) is auditable in P&L. See `change-confirmed-restocking-fee.ts`.
   */
  restockingFeeIncome: BD_ACCOUNT_CODES.RESTOCKING_FEE_INCOME,
  /**
   * 4317 — Inventory Gain (Write-back of Provisions). Credit account for
   * stock-overage physical-count gains and shrinkage-provision reversals.
   * Pair with `merchandise` debit. Never credit `shrinkage` (6711) for a
   * gain — that causes the loss expense to develop a credit balance and
   * inflates net income. See `inventory.contract.ts:gain` branch.
   */
  inventoryGain: BD_ACCOUNT_CODES.INVENTORY_GAIN,

  // ── COGS / Landed Cost ───────────────────────────────────────
  cogsMaterials: BD_ACCOUNT_CODES.COGS_MATERIALS,
  /**
   * 5116 — Import Landed Cost (duty + freight + insurance capitalized
   * to inventory per IAS 2). Use for CIF/FOB import flows. For domestic
   * inbound freight use `carriageInward`.
   */
  importLandedCost: BD_ACCOUNT_CODES.IMPORT_LANDED_COST,
  /** 5117 — Carriage Inward / Freight-In (domestic, capitalized to inventory). */
  carriageInward: BD_ACCOUNT_CODES.CARRIAGE_INWARD,
  /**
   * 5317 — Production-time primary packaging (bottles, blisters, retail
   * boxes — applied during manufacturing). For dispatch-side packaging
   * (cartons, mailers) use `packagingDispatch`.
   */
  packagingProduction: BD_ACCOUNT_CODES.PACKAGING_PRODUCTION,
  /** 5505 — NBR Customs Duty on Imports (when not capitalized into landed cost). */
  customsDuty: BD_ACCOUNT_CODES.CUSTOMS_DUTY,
  /** 5507 — Clearing & Forwarding Agent Commission (typically capitalized). */
  cfAgentCommission: BD_ACCOUNT_CODES.CF_AGENT_COMMISSION,
  shrinkage: BD_ACCOUNT_CODES.SHRINKAGE,

  // ── Operating Expenses ───────────────────────────────────────
  /** 6302 — Admin postage / document courier (NOT customer delivery). */
  postageAdmin: BD_ACCOUNT_CODES.POSTAGE_ADMIN,
  /**
   * 6403 — Internal sales-team commission (commercial reps). Distinct
   * from `marketplaceCommission` (platform cut) and `courierCommission`
   * (logistics partner cut).
   */
  salesCommission: BD_ACCOUNT_CODES.SALES_COMMISSION,
  /**
   * 6405 — Outbound delivery cost (domestic). Own-fleet fuel, last-mile
   * courier flat-rate-per-parcel, etc. For cross-border / weight-priced
   * shipping (DHL / FedEx / Aramex) use `shippingLogisticsExport`.
   */
  freightOutward: BD_ACCOUNT_CODES.FREIGHT_OUTWARD,
  /**
   * 6406 — Cross-border outbound shipping (DHL / FedEx / Aramex weight-
   * priced commercial dispatches, customs clearance fees on outbound).
   * Reported separately from `freightOutward` — different VAT treatment
   * (zero-rated) and cost drivers (chargeable weight, customs).
   */
  shippingLogisticsExport: BD_ACCOUNT_CODES.SHIPPING_LOGISTICS_EXPORT,
  /** 6407 — Outbound packaging consumables (cartons, mailers, bubble wrap). */
  packagingDispatch: BD_ACCOUNT_CODES.PACKAGING_DISPATCH,
  /**
   * 6422 — Marketplace commission (Daraz / Chaldal / Pickaboo / Rokomari
   * cut deducted at payout). Channel-COGS adjacent — separate line so
   * per-channel margin is visible.
   */
  marketplaceCommission: BD_ACCOUNT_CODES.MARKETPLACE_COMMISSION,
  /** 6426 — Sortation-hub / depot rent (volume-based logistics leases). */
  logisticsHubRent: BD_ACCOUNT_CODES.LOGISTICS_HUB_RENT,
  /** 6428 — Per-trip / performance bonus paid to internal couriers. */
  courierDriverBonus: BD_ACCOUNT_CODES.COURIER_DRIVER_BONUS,
  /**
   * 6823 — Marketplace ad-engine spend (Daraz Ads, Chaldal Sponsored
   * Listings, Pickaboo Promotions). Distinct from generic digital
   * marketing and `marketplaceCommission` (per-sale cut).
   */
  marketplaceAds: BD_ACCOUNT_CODES.MARKETPLACE_ADS,
  /** 6824 — Recurring seller-compliance / category-listing fees on marketplaces. */
  marketplaceComplianceFee: BD_ACCOUNT_CODES.MARKETPLACE_COMPLIANCE_FEE,

  /**
   * 6328 — Bank Charges & Commission. Default fee account for payment-
   * gateway settlements (Stripe / SSLCommerz / ShurjoPay processing fees),
   * mobile-money merchant deductions, and ad-hoc bank charges.
   */
  bankCharges: BD_ACCOUNT_CODES.BANK_CHARGES,
  /**
   * 6423 — Courier COD Commission. Default fee account for courier
   * partners (Pathao / RedX / Steadfast / paperfly) on COD remittance.
   * Held distinct from `bankCharges` so logistics-side fees show up in
   * a separate operating-expense line — they scale with delivery volume
   * not payment volume, so finance wants them broken out.
   */
  courierCommission: BD_ACCOUNT_CODES.COURIER_COD_COMMISSION,
  /**
   * 6702 — Bad Debt Written Off. Unrecoverable A/R or clearing-account
   * shortfall. Used by COD settlement (partial collection / short-pay
   * write-off) and marketplace settlement (deductions the platform
   * won't reimburse). Keeps revenue gross; surfaces the loss in P&L.
   */
  badDebt: BD_ACCOUNT_CODES.BAD_DEBT_WRITTEN_OFF,
} as const;

export type BDAccountCode = (typeof BD)[keyof typeof BD];
