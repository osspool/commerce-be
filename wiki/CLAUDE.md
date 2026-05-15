@../../AGENTS.md

# be-prod/wiki — Agent reference index

Read this BEFORE flagging a "missing feature" or starting a gap-fix. Most claimed
gaps are already implemented somewhere — the canonical map of what exists,
where it lives, what test guards it, and what is genuinely missing lives here.

## Why this file exists

Multiple audit passes (2026-05-11 → 2026-05-12) repeatedly produced false
positives — claimed gaps that the code already handled in a different
layer (Streamline workflow, provider webhook, outbox retry, factory
default, package-level engine, etc.). Each false positive cost real
implementation time and risked **duplicating** an existing mechanism.

Before writing a new cron / action / config flag / event subscriber, scan
the "Implemented features" table below. If you find the feature listed,
DO NOT re-implement it — read the linked file + test instead.

## Quick decision tree

```
Claim:  "Feature X is missing"
   │
   ├─ Is X in the "Implemented features" table?
   │     YES → FALSE POSITIVE. Read the linked test to confirm.
   │     NO  → continue
   │
   ├─ Is X in "Known FALSE POSITIVES (with evidence)"?
   │     YES → FALSE POSITIVE. Cite the evidence row.
   │     NO  → continue
   │
   ├─ Could X live in a referenced package (ledger / cart / order / loyalty / arc / streamline)?
   │     LIKELY → grep the package src first, then come back.
   │     NO     → continue
   │
   ├─ Could X be a Streamline workflow (not a cron)?
   │     LIKELY → check src/resources/**/*.workflows.ts
   │     NO     → continue
   │
   └─ Could X be a provider/external concern (Better Auth, bKash, SSLCommerz, NBR)?
         YES → not our responsibility; document the seam.
         NO  → potentially real gap. Add a failing test FIRST, then implement.
```

## Implemented features (with tests)

Every row here is implemented AND test-guarded. Adding a duplicate is a regression.

### Accounting

| Feature | Source | Test |
|---|---|---|
| Bank reconciliation (statement + line match/unmatch + open items) | [src/resources/accounting/bank-reconciliation/bank-reconciliation.resource.ts](../src/resources/accounting/bank-reconciliation/bank-reconciliation.resource.ts) | [tests/unit/bank-reconciliation.test.ts](../tests/unit/bank-reconciliation.test.ts), [tests/unit/bank-reconciliation-contract.test.ts](../tests/unit/bank-reconciliation-contract.test.ts) |
| Withholding cert auto-generation from posted vendor bills | [src/resources/accounting/withholding/withholding-certificate.auto.ts](../src/resources/accounting/withholding/withholding-certificate.auto.ts) | [tests/unit/withholding-auto-cert.test.ts](../tests/unit/withholding-auto-cert.test.ts) |
| Currency revaluation (month-end FX gain/loss) | `POST /accounting/reports/revaluation` via `@classytic/ledger.generateRevaluation()` | [tests/integration/app/revaluation.test.ts](../tests/integration/app/revaluation.test.ts) |
| JE reversal cross-reference (`reversedBy` / `reversalOf`) | `@classytic/ledger/src/schemas/journal-entry.schema.ts:264-273` | ledger package tests |
| Period close approval gate | [src/resources/accounting/period-close/period-close.resource.ts:123](../src/resources/accounting/period-close/period-close.resource.ts) — `advance` action gated `requireRoles('admin', 'finance_admin')` | platform-config-e2e |
| Vendor bill multi-bill payment allocation | `POST /accounting/vendor-bills/bulk-pay` — [src/resources/accounting/vendor-bill/vendor-bill.actions.ts](../src/resources/accounting/vendor-bill/vendor-bill.actions.ts) `bulkPayHandler` | TODO: add bulk-pay-contract.test.ts |
| Budget enforcement (stop/warn/ignore + threshold) | [src/resources/accounting/posting/budget-enforcement-plugin.ts](../src/resources/accounting/posting/budget-enforcement-plugin.ts) | budget tests |
| Budget enforcement company-wide default | `BUDGET_DEFAULT_ENFORCEMENT` env → [src/config/sections/accounting.config.ts](../src/config/sections/accounting.config.ts) — drives schema default in [accounting.engine.ts:303-310](../src/resources/accounting/accounting.engine.ts) | TODO: add budget-default-contract.test.ts |
| Customer Invoice ← Sales Order auto-link | [src/resources/accounting/invoice/invoice.events.ts:58-127](../src/resources/accounting/invoice/invoice.events.ts) — auto-creates invoice on `OrderPaid` with `sourceType: 'Order'`, `sourceId: orderId` | invoice events tests |
| Customer Invoice → Order paymentState sync | [src/resources/accounting/invoice/invoice-to-order.events.ts:28-70](../src/resources/accounting/invoice/invoice-to-order.events.ts) | invoice-to-order tests |
| Recurring invoice scheduling | Streamline workflow `invoice-recurring` in [src/resources/accounting/invoice/invoice.workflows.ts:50-68](../src/resources/accounting/invoice/invoice.workflows.ts) — wired via [src/core/plugins/streamline.plugin.ts](../src/core/plugins/streamline.plugin.ts) | invoice.workflows tests |
| Invoice dunning | Streamline workflow `invoice-dunning` in invoice.workflows.ts (self-rescheduling) | dunning tests |
| Account hierarchy (parent/child for BS/P&L subtotals) | Encoded in `AccountType` country pack (`parentCode`, `isGroup`, `isTotal`) — `flattenAccountTypes()` drives report subtotaling | country-pack tests |
| Platform config: company profile + fiscal year + base currency | [src/resources/platform/platform-config.model.ts](../src/resources/platform/platform-config.model.ts) — `company.legalName`, `company.logo`, `baseCurrency`, `fiscalYearStartMonth` | [tests/integration/app/platform-config-e2e.test.ts](../tests/integration/app/platform-config-e2e.test.ts) |

### Sales / Orders / Cart

| Feature | Source | Test |
|---|---|---|
| Cart guest→login merge | `POST /cart/merge` → `@classytic/cart` `mergeDrafts()` | [tests/integration/app/cart-guest-merge.test.ts](../tests/integration/app/cart-guest-merge.test.ts) |
| Cart concurrent-checkout guard | MongoDB partial unique index on `(draftId, state='open')` — checkout.repository.ts:114-170 | cart tests |
| Customer credit limit + credit days | `customerInvoice.actions.ts` enforces `creditLimit`+`creditEnabled`+`creditDays` at post time | customer-invoice tests |
| Blanket order quantity guard | Fixed `projectedConsumed > cap` (was `consumedQty >= cap`) in `packages/order/src/repositories/blanket-order.repository.ts` | [tests/unit/blanket-order-guard.test.ts](../tests/unit/blanket-order-guard.test.ts) |
| Quotation auto-expiry | `quotation.expiry` cron in [src/cron/index.ts](../src/cron/index.ts) (hourly + 5min jitter) | [tests/unit/quotation-expiry-cron.test.ts](../tests/unit/quotation-expiry-cron.test.ts) |
| Promotion stacking caps | Program-level `maxUsageTotal` + `maxUsagePerCustomer` atomic CAS in `@classytic/promo evaluation.service.ts:390-410` | promo package tests |

### CRM

| Feature | Source | Test |
|---|---|---|
| Lead → Opportunity conversion (FSM) | [src/resources/crm/leads/lead.resource.ts](../src/resources/crm/leads/lead.resource.ts) | lead tests |
| Opportunity → Order link | `linkOrder` action on opportunity resource — persists `metadata.orderId` | [tests/integration/app/crm-opportunity-link-order.test.ts](../tests/integration/app/crm-opportunity-link-order.test.ts) |
| Lead scoring (rescore action) | `rescoreLead` in [src/resources/crm/leads/lead.actions.ts](../src/resources/crm/leads/lead.actions.ts) | [tests/unit/crm-lead-rescore.test.ts](../tests/unit/crm-lead-rescore.test.ts), [tests/unit/crm-lead-rescore-contract.test.ts](../tests/unit/crm-lead-rescore-contract.test.ts) |
| Pipeline stage role gating | Every FSM action (`advanceToStage`, `win`, `lose`, `abandon`, `linkOrder`) gated `permissions: crmPermissions.opportunity.update` | opportunity tests |
| Activity / note audit | Intentional `audit: false` — activities/notes ARE the audit trail | documented in resource comments |

### Cross-cutting

| Feature | Source | Test |
|---|---|---|
| Outbox dead-letter policy | `failurePolicy` in [src/shared/outbox/index.ts](../src/shared/outbox/index.ts) — 5 attempts, exponential 5s→5min backoff, then deadletter | [tests/unit/outbox-dead-letter.test.ts](../tests/unit/outbox-dead-letter.test.ts) |
| Outbox dead-letter visibility | `getDeadLettered(limit)` in [src/shared/outbox/mongo-outbox-store.ts](../src/shared/outbox/mongo-outbox-store.ts) | outbox-dead-letter test |
| Webhook idempotent replay | Atomic CAS on `webhook.eventId` in `transaction.repository.ts:392-401` | transaction tests |
| Payment failure notification | `order:payment.state_updated` trigger filtered on chargeStatus=failed | [tests/unit/notification-payment-failure.test.ts](../tests/unit/notification-payment-failure.test.ts) |
| Loyalty points expiring trigger | `loyalty.points.expiring_soon` notification trigger | [tests/unit/notification-trigger-additions.test.ts](../tests/unit/notification-trigger-additions.test.ts) |
| Low-stock escalation trigger | Second `stock:low` trigger (`type: stock:low_escalation`, priority `high`, sendEmail to admin) | notification-trigger-additions test |
| Loyalty tier evaluation (promotion + demotion) | `loyalty.tier.evaluation` cron in [src/cron/index.ts](../src/cron/index.ts) (daily + 10min jitter) | loyalty package tests |
| Loyalty point expiration sweep | `loyalty.point.expiration` hourly cron — emits `POINTS_EXPIRING_SOON` events | loyalty package tests |
| Streamline workflow REST endpoints | `streamlinePlugin` from `@classytic/arc/integrations/streamline` registered in [src/core/plugins/streamline.plugin.ts](../src/core/plugins/streamline.plugin.ts) | arc package tests |
| Streamline retention indexes (TTL + tenant compound) | `container.syncRetentionIndexes()` (streamline 2.3.2+) via [src/core/plugins/streamline.plugin.ts](../src/core/plugins/streamline.plugin.ts) | streamline package tests |
| Subscription billing sweep | Self-rescheduling Streamline workflow [src/resources/payments/subscription/subscription.workflows.ts](../src/resources/payments/subscription/subscription.workflows.ts) | subscription tests |

### SDK (`packages/commerce-bd-sdk`)

| API surface | Source | Used by FE |
|---|---|---|
| Bank reconciliation hooks | `src/accounting/api/bank-reconciliation.ts`, `src/accounting/hooks/bank-reconciliation.ts` | fe-bigboss/commerce/accounting/dashboard/bank-reconciliation/ |
| CRM Lead `rescore` | `src/crm/api/lead.ts`, `src/crm/hooks/lead.ts` `useRescoreLead` | fe-bigboss/commerce/crm/dashboard/leads/ |
| `@classytic/commerce-sdk/crm` subpath | exports map in [packages/commerce-bd-sdk/package.json](../../packages/commerce-bd-sdk/package.json) | available since 0.6.0 |

## Known FALSE POSITIVES (with evidence)

Audited and confirmed NOT real gaps. Do not "fix" these.

| Claim | Verdict | Evidence |
|---|---|---|
| "No failed payment retry cron" | FALSE POSITIVE | Three layers cover it: (1) outbox `failurePolicy` retries with exp backoff 5×, then deadletters; (2) providers (bKash/Nagad/SSLCommerz/Stripe) retry webhooks server-side for 24-48h; (3) webhook CAS dedup in `transaction.repository.ts:392-401` prevents double-processing on replays. Adding a cron creates a 3-way retry storm with no idempotency gate. |
| "No invoice dunning cron" | FALSE POSITIVE | Dunning is a self-rescheduling Streamline workflow (`invoice.workflows.ts:28-48`), not a cron job. |
| "No recurring JE scheduling" | FALSE POSITIVE | Handled by `@classytic/streamline` durable workflow `invoice-recurring`. |
| "Loyalty point-expiry pre-warning job missing" | FALSE POSITIVE | `processExpirations()` cron fires hourly and emits `POINTS_EXPIRING_SOON` events via the loyalty package. |
| "Dual invoice system (A/R view vs standalone)" | FALSE POSITIVE | `customer-invoice` is a VIEW facade over `JournalEntry` via `control-account-resource.factory.ts`. Same model. |
| "Cart: no TTL" | FALSE POSITIVE | `draftTtlSeconds` exists in `@classytic/cart` (opt-in). Not enabling it is a business decision, not a missing feature. |
| "Customer: no credit limit" | PARTIAL FALSE POSITIVE | `creditLimit`+`creditEnabled`+`creditDays` exist and are enforced. Only `paymentTermsId` (term templates) is missing. |
| "Supplier not linked to accounting Partner" | BY DESIGN | `Supplier._id` IS the partner ID in ledger (`partner-resolver.service.ts`). Documented invariant. |
| "Promotion stacking uncapped" | FALSE POSITIVE | Program-level `maxUsageTotal`+`maxUsagePerCustomer` enforced via atomic CAS in promo package. Rules/Rewards have no individual caps by intentional design. |
| "CRM activities + notes unaudited (`audit: false`)" | FALSE POSITIVE | Intentional — activities/notes ARE the audit trail. Edits/deletes intentionally not separately tracked. |
| "JE reversal missing `reversal_basis`" | FALSE POSITIVE | `reversedBy` + `reversalOf` cross-reference fields exist in ledger schema (lines 264-273) and are set atomically by `reverse()`. |
| "Period close: no approval gate" | FALSE POSITIVE | Action-level gate via `requireRoles('admin', 'finance_admin')` on `advance` covers every step including `close_period`. |
| "Sales-order → invoice link missing" | FALSE POSITIVE | Auto-created on `OrderPaid` event with `sourceType: 'Order'`, `sourceId: orderId` (invoice.events.ts:58-127). |
| "Loyalty tier downgrade missing" | FALSE POSITIVE | `loyalty.tier.evaluation` cron runs daily; `evaluateAll()` handles both promotion AND demotion. |
| "CRM pipeline stage role-gating missing" | FALSE POSITIVE | Every FSM transition action gated `permissions: crmPermissions.opportunity.update`. |
| "No account hierarchy" | FALSE POSITIVE | Hierarchy encoded in country pack via `AccountType.parentCode/isGroup/isTotal`. Drives BS/P&L subtotaling. Document-level `parentId` would be redundant — reports don't read it. |
| "Cycle count variance not auto-posted" | PARTIAL FALSE POSITIVE | All adjustment paths go through `inventory.controller.ts` which publishes `accounting:inventory.adjusted` (lines 423-438). |
| "Cart concurrent-checkout guard missing" | FALSE POSITIVE | MongoDB partial unique index on `(draftId, state='open')` enforces single-open-checkout-per-draft (checkout.repository.ts:114-170). |
| "No materialized report caching" | FALSE POSITIVE | Period close step results (trial balance, balance-sheet snapshot, P&L summary) persist in `PeriodCloseStepDoc.result` (period-close.model.ts:54) and `BalanceSheetSnapshot` (packages/ledger/src/reports/balance-sheet.ts:331-343). Not a separate table, but materialized + cached on period close. |
| "No quantity-break pricing" | FALSE POSITIVE | `PriceRule.tiers` array of `TierLadder { minQty, maxQty }` in packages/pricelist/src/models/price-list.model.ts:72-90, fully wired through the resolver. |
| "No date-range / seasonal pricing" | FALSE POSITIVE | `validFrom` + `validTo` on PriceRule in packages/pricelist/src/models/price-list.model.ts:119-120. |
| "No bundle/kit products" | PARTIAL | Catalog interface ships `bundleable` flag (product-types/type.interface.ts:48), `BundleMonetization` type (catalog-core/monetization.vo.ts:87-98), `relationship.vo.ts:43-45 bundles?:ProductRef[]`. No built-in bundle handler registered in be-prod yet — hosts must provide a custom `ProductTypeHandler`. Architecture ready, turn-key handler absent. |

## Genuinely OPEN gaps (verified)

Real gaps remaining (much smaller than the original audit suggested):

| Gap | Severity | Notes |
|---|---|---|
| No Mushak 6.10 NBR e-filing bridge | CRITICAL | BLOCKED — requires NBR portal API credentials + `buildMushak610` in `@classytic/bd-tax`. |
| Bundle product handler (turn-key) | MAJOR | Catalog architecture supports bundles (`bundleable`, `BundleMonetization`, `relationship.bundles`); needs a built-in `ProductTypeHandler` registered in be-prod for the no-config path. |
| RecurringInvoice: no operator dashboard | MAJOR-PARTIAL | Streamline workflow exists; missing FE schedule-management UI. |
| Failed-payment abandoned sweep (NOT retry) | MINOR | Optional — flag PENDING transactions >24h for ops review. Different from retry. |
| Encumbrance (reserve before posting) | MAJOR | Budget enforces at post-time only (budget-enforcement-plugin.ts). No pre-allocation/commitment table. Multiple concurrent JEs can over-commit a budget until the last one trips the guard. |

## How to add a new entry

When you implement a new feature:

1. Add a row to the relevant section above. Link `[source](path)` and `[test](path)`.
2. Write the test FIRST (RED → GREEN). Source-only changes without a test invite regression.
3. If a previous claim was a false positive, move it to "Known FALSE POSITIVES" with one-line evidence.
4. Update `wiki/erp-gaps.md` status column to match.

## Anti-patterns (learned the hard way)

- **Don't write a cron when a Streamline workflow already self-reschedules.** Three retry layers stacked is worse than one.
- **Don't audit a "missing" feature without reading the relevant package source.** Half the audit hits live in `@classytic/ledger`, `@classytic/cart`, `@classytic/loyalty`, `@classytic/promo`, `@classytic/order`.
- **Don't add a config flag without wiring it.** If you add `BUDGET_DEFAULT_ENFORCEMENT`, also wire it through the schema default and write a test that flips the env var.
- **Don't write source-code-content regex tests as the only guard.** They catch "did the file change" but miss "does the behavior work". Pair them with an integration test where possible.
- **Don't claim a feature is missing because it's not in `cron/index.ts`.** Check `*.workflows.ts` files first.
- **Don't bypass `BaseApi`** in SDK code. Every API call must go through `BaseApi.request()` so auth + org-id headers inject correctly.
- **Don't propose extracting `commerce/dashboard/` to a package.** Documented decision in fe-bigboss/CLAUDE.md — single-client solo-dev workload.
