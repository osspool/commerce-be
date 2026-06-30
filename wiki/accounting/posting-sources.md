# Posting sources — who posts what (and the no-double-post rule)

Two tiers can post AR/AP. They are **mutually exclusive per source**, gated by
the `INVOICE_AUTO_*` flags. The sales core never imports accounting — it only
emits events, so a pure-ecom host can run with the whole accounting tier absent.

```
TIER 1 — direct posting (default; flags = 'off')
  accounting:order.paid     → order-paid.handler        → sales / COD JE
  purchase:received         → purchase-received.handler → vendor-bill JE (Cr A/P)
  pos:shift.closed          → shift.contract LedgerBridge → POS sales JE
        each → createPosting() with a stable idempotencyKey   posting.service.ts

TIER 2 — invoice engine (opt-in; INVOICE_AUTO_* != 'off')
  OrderPaid(paymentMethod='credit') → invoice.events → invoice.createAndPost(out_invoice)  Dr A/R
  PurchaseReceived                  → invoice.events → invoice.createAndPost(in_invoice)   Cr A/P
  day.auto-close                    → invoice.events → invoice.createReceipt()             POS receipt
        each posts via ledger-classytic.bridge (sourceModel:'Invoice')
```

## The rule: when Tier 2 owns a case, Tier 1 MUST yield

Both tiers subscribe to the SAME event. Their idempotency keys differ
(`vendor-bill-{po}` vs `auto-bill-purchase-{po}`), so the posting-service dedup
**cannot** catch a cross-tier duplicate. The direct handlers therefore early-return:

- `purchase-received.handler.ts` → `if (config.invoice.autoPurchase !== 'off') return null` — invoice engine is the vendor-bill of record.
- `order-paid.handler.ts` → `if (config.invoice.autoSales !== 'off' && gateway === 'credit') return null` — invoice engine owns credit-sale A/R. Prepaid/COD still post direct (Tier 2 never makes documents for them).

**Adding a new auto-invoice case?** Add the matching `return null` guard in the
direct handler for that case, or you double-post. Covered by
[posting-double-post-guard.test.ts](../../tests/unit/posting-double-post-guard.test.ts).

## Credit / debit notes — two surfaces, same routing capability

- **Doc-backed** (a real `@classytic/invoice` document exists): use the engine's
  `creditNoteFull` / `creditNotePartial` — per-line `accountCode` routes service
  credits to the right GL ([invoice line fix](../../../packages/invoice/src/services/line-math.ts)).
- **Doc-less** (order/COD/purchase-derived AR/AP, JE-view only): use the
  `credit-debit-note.contract` action — optional `contraAccount` routes the
  offsetting leg (service fee / SLA penalty / allowance) instead of the default
  Returns account (5503 / 4114).

## Files

| File | Purpose |
|---|---|
| [order-paid.handler.ts](../../src/resources/accounting/events/handlers/order-paid.handler.ts) | direct sales/COD posting + credit-sale yield guard |
| [purchase-received.handler.ts](../../src/resources/accounting/events/handlers/purchase-received.handler.ts) | direct vendor-bill posting + auto-purchase yield guard |
| [invoice.events.ts](../../src/resources/accounting/invoice/invoice.events.ts) | Tier-2 auto-invoice subscribers (flag-gated) |
| [credit-debit-note.contract.ts](../../src/resources/accounting/posting/contracts/credit-debit-note.contract.ts) | JE-view credit/debit note + `contraAccount` routing |
| [invoice.config.ts](../../src/config/sections/invoice.config.ts) | `INVOICE_AUTO_SALES/PURCHASE/POS` policy (default `off`) |
