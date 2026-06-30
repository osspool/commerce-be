# accounting wiki

Accounting subsystem flow maps. Every JE-touching path goes through
`@classytic/ledger` via `accounting.engine.ts` — never construct JEs by
hand in resources.

## Pages

| Flow | When | File |
|---|---|---|
| [posting-sources](posting-sources.md) | who posts AR/AP + the no-double-post rule when `INVOICE_AUTO_*` is on | direct handlers vs invoice engine |
| [vendor-bill](vendor-bill.md) | post / pay / credit-note / bulk-pay | `/accounting/vendor-bills/...` |
| [customer-invoice](customer-invoice.md) | post / receive / debit-note / auto-from-order | `/accounting/customer-invoices/...` |
| [period-close](period-close.md) | 5-step wizard close + reopen | `/accounting/period-close/...` |
| [bank-reconciliation](bank-reconciliation.md) | match statement lines to JE items | `/accounting/bank-reconciliation/...` |
| [budget-enforcement](budget-enforcement.md) | post-time stop/warn/ignore guard | plugin on JournalEntry repo |
| [withholding-cert-auto](withholding-cert-auto.md) | auto-create cert when bill posts with `withholdVds:true` | event-driven |
| [revaluation](revaluation.md) | month-end FX gain/loss | `/accounting/reports/revaluation` |

## Glossary

- **engine** = `@classytic/ledger` accounting engine — owns the `JournalEntry`, `Account`, `Budget`, etc. models. One singleton, eagerly created in [`accounting.engine.ts`](../../src/resources/accounting/accounting.engine.ts).
- **control account** = the GL account that aggregates partner balances. A/R = `1141`, A/P = `2111`. The "vendor bill" / "customer invoice" resources are VIEWS over JournalEntries that touch these accounts.
- **partner posting** = JE pattern where one journalItem carries `partnerId` (supplier/customer) so the open-items reconciliation can group bills + payments + credit notes by partner+source.
- **group settlement** = `maybeSettleGroup()` in [`posting/open-balance.service.ts`](../../src/resources/accounting/posting/open-balance.service.ts) — atomically marks a bill+payments+CNs as `matched` when net open balance hits zero.
- **posting contract** = a typed function in `posting/contracts/*.ts` that turns a domain event (purchase received, refund issued) into a typed JE payload. Single source of truth for "what JEs does this event produce."

## Scope reminders

Cross-checked against [erp-gaps.md](../erp-gaps.md) and [CLAUDE.md](../CLAUDE.md). Before flagging an "accounting gap" — read CLAUDE.md table of false positives first.
