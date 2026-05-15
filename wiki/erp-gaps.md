# ERP Gap Register

Reviewed 2026-05-12. 93 resource files across 58 feature areas.
Format: area — what exists → gaps (CRITICAL / MAJOR / MINOR)

**Before editing:** read [CLAUDE.md](CLAUDE.md) first — many "obvious" gaps
are false positives covered by Streamline workflows, package-level
features, or factory defaults. The CLAUDE.md tracks evidence so the same
false positive doesn't get re-flagged on the next audit pass.

---

## ACCOUNTING

### Chart of Accounts
Exists: BFRS-seeded, enable/disable, bulk-create, company-wide.
- CRITICAL: Flat structure — no parent/child hierarchy (blocks P&L subtotaling, structural reports)
- CRITICAL: No opening balances on accounts (only partner-level via partner.actions.ts)
- MINOR: No account archival/deprecation workflow

### Journal Entries
Exists: draft-save, approval chain, post/reverse/duplicate/archive, by-source lookup.
- CRITICAL: No recurring JE scheduling (month-end accruals must be manually created every month)
- CRITICAL: reverse action creates entry but no `reversal_basis` cross-reference — audit link missing
- MINOR: No JE attachments, no JE comment/note field

### Period Close
Exists: 5-step wizard (validate→trial-balance→bank-reconcile→close→archive), reopen support.
- CRITICAL: No approval gate on final "close_period" step (finance director sign-off)
- MINOR: No dry-run preview; no rollback of close session

### Financial Reports
Exists: real-time TB, Balance Sheet, P&L, GL, Cash Flow, AP/AR Aging, Partner Ledger, Daybook, Budget vs Actual.
- CRITICAL: No materialized/cached snapshots — every report aggregates live (slow at scale)
- MAJOR: No segment reporting (by branch, cost center, department)
- MAJOR: No budget variance alerts/threshold triggers
- MINOR: No report scheduling or email distribution

### Tax (Mushak / VAT)
Exists: Mushak 6.3 VAT invoice CRUD, 9.1/9.2 monthly return, BD-tax + ledger-bd integration.
- CRITICAL: No Mushak 6.10 NBR e-filing bridge (handler exists, no submission API)
- CRITICAL: No withholding certificate auto-generation from posted JEs — CRUD only, manual
- CRITICAL: No TDS/VDS certificate number assignment or validity enforcement
- CRITICAL: No Mushak PDF export (invoice has one, Mushak doesn't)
- MAJOR: No tax liability reconciliation (posted vs due to NBR)

### Vendor Bills (A/P)
Exists: A/P control-account view, post/pay/credit-note actions, open balance.
- CRITICAL: No 3-way match (PO ↔ GRN ↔ bill) — bills post without PO link
- CRITICAL: No bill approval workflow (separate from JE approval)
- CRITICAL: No payment allocation ("apply payment to open bills")
- CRITICAL: No payment terms / due-date dunning alerts
- MAJOR: No multi-currency bill support

### Customer Invoices (A/R)
Exists: A/R control-account view, post/receive/debit-note, credit-limit check on post.
- CRITICAL: **Dual invoice system** — `customer-invoice.resource.ts` (A/R view) AND `invoice.resource.ts` (standalone model). Source of truth unclear; data integrity risk
- CRITICAL: No sales-order → invoice link (invoices created independently of orders)
- CRITICAL: No delivery matching (invoice can post before shipment confirmed)
- MAJOR: RecurringInvoice model exists (CRUD only) — no scheduler wired

### Exchange Rates
Exists: Manual rate entry per currency pair + date + purpose (buying/selling/general).
- CRITICAL: No currency revaluation (month-end mark-to-market for foreign assets/liabilities)
- CRITICAL: No realized/unrealized forex gain-loss posting on settlement
- MAJOR: Manual-only — no Bangladesh Bank API auto-fetch
- MINOR: No rate fallback chain (use yesterday's if today missing)

### Budget
Exists: Branch budgets, draft→approved workflow, enforcement plugin (stop/warn/ignore), budget vs actual report.
- CRITICAL: Enforcement defaults to `ignore` — no company-wide enforcement setting
- CRITICAL: No budget variance alerts at threshold
- MAJOR: No budget revision history (revision counter increments, no version compare)
- MAJOR: No encumbrance (reserve before posting, not post-then-check)
- MINOR: No carry-forward / rollover at year-end

### Withholding Certificates
Exists: VDS/TDS CRUD, reconciled flag, getUnreconciledTotal, reconcile action.
- CRITICAL: Not auto-generated from JEs — manual entry only
- CRITICAL: No certificate PDF for supplier
- CRITICAL: No source-to-certificate tracing (which JE line generated this cert)

### Bank Reconciliation
Exists: Nothing.
- CRITICAL: No bank statement import or cash-to-bank matching workflow

### Recurring Journal Entries
Exists: Nothing (RecurringInvoice exists for AR, not for JEs).
- CRITICAL: No recurring JE scheduling — accruals are fully manual

---

## INVENTORY / WMS

### Lot / Batch Tracking
Exists: lot.resource.ts with lotCode, serialCode, vendorBatchRef, trackingType.
- CRITICAL: No `expiryDate` field on lot model — FEFO picking impossible
- CRITICAL: No expiry alerts or auto-quarantine on expired lots

### Purchase Orders
Exists: draft→approved→received→paid, approval matrix by amount+supplier, GRN via receive action.
- CRITICAL: No mandatory QC gate before receive — defective stock enters undetected
- CRITICAL: No 3-way match to vendor bill (PO exists, bill exists, no link)

### Cycle Count / Variance
Exists: full/cycle/spot sessions, freeze policies, variance reconciliation → adjustment moves.
- CRITICAL: Variance creates Flow moves but no automatic GL journal entry — manual posting loop required

### Supplier → Accounting Link
Exists: supplier.resource.ts (inventory-only), supplier-performance.resource.ts.
- CRITICAL: Supplier not mapped to accounting Partner — invoice matching and AP reconciliation are manual

### Scrap / Write-off
Exists: Implicit via Flow adjustments, no dedicated resource.
- MAJOR: No scrap reason codes, no RTV (return-to-vendor) workflow, no scrap variance report

### Replenishment
Exists: reorder-point + target-level rules, /evaluate dry-run, auto-generate POs.
- MAJOR: Static min-max only — no demand forecasting, no seasonality signals

### Consignment
Exists: settlement tracking, outstanding value rollup, ownership flip via move.
- MAJOR: No scheduled batch reconciliation — manual /settle/:moveId only; no vendor payment trigger

---

## SALES / ORDERS

### Cart
Exists: add/update/remove, clear, checkout (start/commit/cancel), guest cart, **merge** (POST /cart/merge — [FIXED 2026-05-11]).
- FALSE POSITIVE: Cart TTL — `draftTtlSeconds` config option exists in @classytic/cart (opt-in), not enabled in be-prod (business decision, not a gap)
- ~~CRITICAL: No guest→login cart merge~~ **FIXED** — `mergeDrafts()` from @classytic/cart was implemented; wired POST /cart/merge. Test: `tests/integration/app/cart-guest-merge.test.ts`
- CRITICAL: No concurrent-checkout guard (session binding not enforced)

### Customer Credit
Exists: lifetime stats (revenue, order count), RFM cohorts, tier membership.
- CRITICAL: No `creditLimit` or `paymentTermsId` on customer model — B2B invoicing unsupported

### RMA
Exists: request→approve→receive→inspect→resolve, credit note, restock flow.
- MAJOR: No automatic refund trigger after inspection approval — manual JE + payment reversal

### Promotions
Exists: stackable promos, programs/rules/rewards/evaluation, per-order application.
- CRITICAL: No per-customer or per-promo usage cap — unbounded stacking possible
- MAJOR: No promo allocation tracking (issued vs redeemed counts)

### Quotations
Exists: draft→sent→viewed→accepted→converted FSM, expiry field.
- MAJOR: No auto-reject job on expiry — field exists, nothing enforces it

### Blanket Orders
Exists: standing orders, cadence, line templates, release order creation.
- MAJOR: No cumulative quantity guard — over-order against blanket cap not blocked

### POS
Exists: product browse + barcode, shift management, cash drawer, shift ledger.
- MAJOR: No offline mode — all routes require live backend
- MINOR: No receipt printing endpoint (client-side only)

### Loyalty
Exists: earn/redeem, tier ladder, earning rules, point expiry (fixed TTL), manual adjustment.
- MAJOR: No tier downgrade automation — bulk /evaluate only, no periodic demotion scheduler

### Pricing
Exists: customer-group pricing, per-branch pricing, variant pricing.
- MAJOR: No quantity-break pricing (minQty tiers)
- MAJOR: No date-range / seasonal pricing

### Products
Exists: full CRUD, BM25 search, variants, category, stock sync.
- MAJOR: No variant matrix builder (size × color grid)
- MAJOR: No bundle/kit products (multi-SKU packaging)
- MINOR: No digital product type (licenses, files)

---

## CRM

### Lead Conversion
Exists: convertedContactId, convertedOpportunityId fields on lead model.
- CRITICAL: No conversion action or workflow — lead → opportunity → order flow absent

### Lead Scoring
Exists: `score` field + index on lead model.
- CRITICAL: Score never updated — no scoring engine or cron evaluator

### Activity Audit
Exists: call/meeting/email/task activity types.
- CRITICAL: `audit: false` on activity.resource.ts and note.resource.ts — call logs unaudited
- Fix: set `audit: true` on both

### Email Integration
Exists: outbound email templates only.
- MAJOR: No bi-directional email sync (inbound replies not tracked)
- MAJOR: No calendar integration (meeting scheduling)

### CRM Permissions
Exists: baseline role checks only.
- MAJOR: Pipeline stage transitions open to all authenticated staff — no role gating

---

## CROSS-CUTTING

### Notifications — Missing Triggers
Exists: 11 triggers (order lifecycle, stock:low, transfer lifecycle, member:joined, purchase:received).
- CRITICAL: No payment failure notification — **FIXED** 2026-05-11
- CRITICAL: No invoice overdue / dunning trigger — FALSE_POSITIVE: dunning is a self-rescheduling Streamline workflow (invoice.workflows.ts), emits no discrete event; trigger would have nothing to bind to
- CRITICAL: No subscription renewal reminder — BLOCKED: subscription workflow (subscription.workflows.ts) emits no renewal-approaching event; would require adding event emission to the workflow
- MAJOR: No loyalty point-expiry warning — **FIXED** 2026-05-11: `loyalty.points.expiring_soon` trigger added; binds to `LoyaltyEvents.POINTS_EXPIRING_SOON` event emitted by loyalty package. Test: notification-trigger-additions.test.ts
- MAJOR: No POS shift open-too-long alert — OPEN
- MAJOR: No low-stock escalation — **FIXED** 2026-05-11: second `stock:low` trigger added with type `stock:low_escalation`, routes to admin with high priority + email. Test: notification-trigger-additions.test.ts

### Cron Jobs — Missing
Exists: outbox relay, reservation cleanup, redemption cleanup, point expiry, replenishment, tier evaluation, subscription billing sweep.
- CRITICAL: No invoice dunning sweep — FALSE_POSITIVE: dunning is Streamline-driven (not cron)
- CRITICAL: No failed payment retry — **FALSE_POSITIVE** 2026-05-12: three layers cover it — (1) outbox `failurePolicy` retries with exp backoff 5×, then deadletters (shared/outbox/index.ts:6-13); (2) provider gateways (bKash/Nagad/SSLCommerz/Stripe) retry webhooks server-side for 24-48h; (3) webhook CAS dedup in transaction.repository.ts:392-401. Adding a cron creates a 3-way retry storm.
- MAJOR: No loyalty point-expiry pre-warning job — FALSE_POSITIVE: `processExpirations()` cron already fires hourly; `POINTS_EXPIRING_SOON` event is emitted by loyalty package during sweep
- MAJOR: No quotation expiry sweep — **FIXED** 2026-05-11: `quotation.expiry` cron added (hourly + 5min jitter); calls `orderEngine.repositories.quotation.expireDue()` with system cron context. Test: quotation-expiry-cron.test.ts
- MAJOR: No outbox dead-letter / escalation — **FIXED** 2026-05-11: `failurePolicy` added to EventOutbox in shared/outbox/index.ts; dead-letters after 5 attempts with exponential backoff (5s base, 5min max); `getDeadLettered()` added to MongoOutboxStore for visibility. Test: outbox-dead-letter.test.ts

### Platform Config
Exists: generic /config GET+PATCH.
- CRITICAL: No company profile resource (legal name, tax ID, logo, base currency)
- CRITICAL: No fiscal year configuration resource
- MAJOR: No default currency / locale settings

### Analytics Gaps
Exists: ecommerce KPIs, HQ sales consolidation, full accounting reports.
- MAJOR: No inventory analytics (turnover, slow-movers, replenishment ROI)
- MAJOR: No CRM analytics (pipeline value, funnel, lead source ROI)
- MAJOR: No CLV / cohort analysis
- MINOR: No notification delivery analytics

### Payment Providers
Exists: webhook router, manual verify/reject, revenue engine dispatch.
- MAJOR: No SSLCommerz, bKash, Nagad, or Stripe provider implementations visible in resources/ — verify in shared/revenue or config/providers

---

## SEVERITY SUMMARY

Legend: **STATUS** — `OPEN` | `FIXED` | `FALSE_POSITIVE`

| # | Gap | Severity | Status |
|---|-----|----------|--------|
| 1 | Dual invoice system (A/R view vs standalone) | CRITICAL | FALSE_POSITIVE — customer-invoice is a VIEW facade over JournalEntry via control-account-resource.factory.ts |
| 2 | Lot model missing expiryDate — no FEFO | CRITICAL | PARTIAL — `expiresAt` field exists (lot.schemas.ts:23,37,56); FEFO picking logic absent from warehouse allocation (Flow engine concern) |
| 3 | Cart: no guest merge | CRITICAL | **FIXED** — POST /cart/merge wired 2026-05-11; test: cart-guest-merge.test.ts |
| 3a | Cart: no TTL | CRITICAL | FALSE_POSITIVE — `draftTtlSeconds` exists in @classytic/cart, opt-in (business decision) |
| 3b | Cart: no concurrent-checkout guard | CRITICAL | FALSE_POSITIVE — MongoDB partial unique index on `(draftId, state='open')` enforces single-open-checkout-per-draft at DB level; loser race re-fetches winner (checkout.repository.ts:114-170) |
| 4 | Customer: no credit limit or payment terms | CRITICAL | PARTIAL FALSE_POSITIVE — `creditLimit`+`creditEnabled`+`creditDays` exist and are enforced (customer-invoice.actions.ts); only `paymentTermsId` (payment term templates) is missing |
| 5 | No bank reconciliation workflow | CRITICAL | **FIXED** 2026-05-11 — `BankStatement` model + `bank-reconciliation` resource added; CRUD for statements with embedded lines; `matchLine`/`unmatchLine` actions wire `ledger.repositories.reconciliations.match/unmatch()`; `GET /open-items` surfaces unmatched JE items. Test: bank-reconciliation.test.ts |
| 6 | No recurring JE scheduling | CRITICAL | FALSE_POSITIVE — handled by `@classytic/streamline` durable workflows (invoice.workflows.ts), not cron |
| 7 | Cycle count variance not auto-posted to GL | CRITICAL | PARTIAL FALSE_POSITIVE — all adjustment paths go through inventory.controller.ts which publishes `accounting:inventory.adjusted` (lines 423-438). Fallback subscriber absent but not currently exercised |
| 8 | Supplier not linked to accounting Partner | CRITICAL | BY DESIGN — `Supplier._id` IS the partner ID in ledger (partner-resolver.service.ts). Assumption undocumented; silent failure on deleted supplier is the real risk |
| 9 | No 3-way match (PO ↔ GRN ↔ vendor bill) | CRITICAL | PARTIAL FALSE_POSITIVE — `purchaseOrderId` on SupplierBill exists; group-based settlement matching via `sourceRef.sourceId` implemented. Gap: GRN lives in Flow WMS, no single receipt doc linking all three with API-layer enforcement |
| 10 | Withholding certs not auto-generated from JEs | CRITICAL | **FIXED** 2026-05-11 — `postBillAction` now auto-creates a `WithholdingCertificate` (type VDS, direction ISSUED) after posting a vendor bill with `withholdVds:true`; links `journalEntryId`+`sourceId` for tracing. Pure helper `buildCertificateData` in withholding-certificate.auto.ts. Test: withholding-auto-cert.test.ts |
| 11 | No Mushak 6.10 NBR e-filing | CRITICAL | BLOCKED — requires NBR portal API credentials, endpoint URLs, and `buildMushak610` in @classytic/bd-tax (not yet implemented). Generation logic (6.3/9.1/9.2) exists; submission bridge needs external API access. |
| 12 | No currency revaluation / forex gain-loss | CRITICAL | **FIXED** 2026-05-11 — `POST /accounting/reports/revaluation` wired; calls `generateRevaluation()` from @classytic/ledger (already fully implemented); branch-scoped via `orgField: 'organizationId'`. Test: revaluation.test.ts |
| 13 | Promotion stacking uncapped | CRITICAL | FALSE_POSITIVE — Program-level `maxUsageTotal`+`maxUsagePerCustomer` enforced via atomic CAS in promo package (evaluation.service.ts:390,398-410). Rules/Rewards have no individual caps (intentional design) |
| 14 | CRM activities + notes unaudited | CRITICAL | FALSE_POSITIVE — `audit: false` is intentional; activities/notes ARE the audit trail. Edits/deletes not separately tracked (accepted design tradeoff, documented in resource comments) |
| 15 | No invoice dunning cron | CRITICAL | FALSE_POSITIVE — dunning runs as a self-rescheduling Streamline workflow (invoice.workflows.ts:28-48), not a cron job |
| 16 | No payment failure notification | CRITICAL | **FIXED** 2026-05-11 — `order:payment.state_updated` trigger added (filters on chargeStatus=failed); type `payment:failed`; priority high. Test: notification-payment-failure.test.ts |
| 17 | No company profile / fiscal year resource | CRITICAL | **FIXED** 2026-05-11 — added `company{legalName,logo}`, `baseCurrency`, `fiscalYearStartMonth` to PlatformConfig. Test: platform-config-e2e.test.ts |
| 18 | CRM lead→order conversion absent | CRITICAL | **FIXED** 2026-05-11 — `linkOrder` action added to opportunity resource; persists `metadata.orderId`+`metadata.orderLinkedAt`. Test: crm-opportunity-link-order.test.ts |
| 19 | No account hierarchy | CRITICAL | FALSE_POSITIVE — hierarchy is fully encoded in the country pack: every `AccountType` carries `parentCode`, `isGroup`, and `isTotal` flags. `flattenAccountTypes()` drives BS/P&L subtotaling already. Custom accounts inherit the hierarchy via `accountTypeCode`; a document-level `parentId` would need report-level support to do anything and isn't what the reports use. |
| 20 | No materialized report caching | MAJOR | OPEN |
| 21 | Blanket order quantity guard missing | MAJOR | **FIXED** 2026-05-11 — condition was `consumedQty >= cap` (too late); fixed to `projectedConsumed > cap` in packages/order/src/repositories/blanket-order.repository.ts. Test: blanket-order-guard.test.ts |
| 22 | Quotation auto-expiry absent | MAJOR | **FIXED** 2026-05-11 — `quotation.expiry` cron added to cron/index.ts (hourly); calls `expireDue()` cross-org with system cron context. Test: quotation-expiry-cron.test.ts |
| 23 | No outbox dead-letter policy | MAJOR | **FIXED** 2026-05-11 — `failurePolicy` (dead-letter after 5 attempts, exponential backoff 5s→5min) added to EventOutbox; `getDeadLettered()` added to MongoOutboxStore. Test: outbox-dead-letter.test.ts |
| 24 | No loyalty points-expiring-soon notification | MAJOR | **FIXED** 2026-05-11 — `loyalty.points.expiring_soon` trigger added to NOTIFICATION_TRIGGERS. Test: notification-trigger-additions.test.ts |
| 25 | No low-stock escalation to purchase manager | MAJOR | **FIXED** 2026-05-11 — second `stock:low` trigger (type: `stock:low_escalation`) added with high priority + email to admin. Test: notification-trigger-additions.test.ts |
| 26 | CRM lead score never updated | CRITICAL | **FIXED** 2026-05-11 — `rescoreLead` action added to lead.actions.ts + registered in lead.resource.ts; scores from email/phone/company/source/status signals. Test: crm-lead-rescore.test.ts |
| 27 | Vendor bill payment allocation across multiple bills | CRITICAL | **FIXED** 2026-05-12 — `POST /accounting/vendor-bills/bulk-pay` route added with `bulkPayHandler` in vendor-bill.actions.ts; validates each allocation against per-bill open balance BEFORE creating postings (all-or-nothing pre-flight), caps at 50 allocations/call. Test: vendor-bill-bulk-pay-contract.test.ts |
| 28 | No company-wide budget enforcement default | MAJOR | **FIXED** 2026-05-12 — `BUDGET_DEFAULT_ENFORCEMENT` + `BUDGET_DEFAULT_THRESHOLD_PERCENT` env vars added to config/sections/accounting.config.ts; drives Budget schema defaults in accounting.engine.ts (replaces hardcoded `'ignore'`/`100`). Per-budget override at create time still wins. Test: budget-default-enforcement-contract.test.ts |
| 29 | No failed payment retry cron | CRITICAL | **FALSE_POSITIVE** 2026-05-12 — three layers cover it: (1) outbox `failurePolicy` retries 5× exp backoff then deadletters; (2) provider gateways retry webhooks 24-48h; (3) webhook CAS dedup. See CLAUDE.md for full evidence. |
| 30 | No materialized report caching | MAJOR | **FALSE_POSITIVE** 2026-05-12 — `PeriodCloseStepDoc.result` (period-close.model.ts:54) persists trial-balance + balance-sheet + P&L snapshots at period close. `BalanceSheetSnapshot` shape in packages/ledger/src/reports/balance-sheet.ts:331-343. Not a separate snapshot table, but materialized + frozen on close. |
| 31 | No quantity-break pricing | MAJOR | **FALSE_POSITIVE** 2026-05-12 — `PriceRule.tiers` (`TierLadder { minQty, maxQty }`) in packages/pricelist/src/models/price-list.model.ts:72-90 with full resolver wiring. |
| 32 | No date-range / seasonal pricing | MAJOR | **FALSE_POSITIVE** 2026-05-12 — `validFrom` + `validTo` fields on PriceRule (packages/pricelist/src/models/price-list.model.ts:119-120). |
| 33 | No bundle/kit products | MAJOR | **PARTIAL** 2026-05-12 — catalog architecture ready (`bundleable` flag, `BundleMonetization` type, `relationship.bundles`); no built-in `ProductTypeHandler` registered. Hosts must register a custom handler today. Real but narrower than claimed. |
| 34 | Encumbrance (reserve-before-posting) | MAJOR | **REAL_GAP** 2026-05-12 — budget-enforcement-plugin.ts is post-time only; no commitment/reservation table; concurrent JEs can over-commit until the last one trips the guard. |

## Files

| Subsystem | Key files reviewed |
|-----------|-------------------|
| Accounting | `accounting/`, `finance/`, `accounting.engine.ts` |
| Inventory | `inventory/`, `inventory/warehouse/` |
| Sales | `sales/orders/`, `sales/cart/`, `sales/pos/`, `sales/loyalty/` |
| CRM | `crm/` (all 7 resources) |
| Cross-cutting | `cron/`, `notifications/`, `platform/`, `config/permissions/` |
