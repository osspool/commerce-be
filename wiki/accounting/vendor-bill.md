# Vendor bill (A/P)

A vendor bill is NOT a separate model — it's a `JournalEntry` whose `2111`
journalItem carries a `partnerId: supplierId`. The "resource" is a view
over JEs filtered by that pattern via `defineControlAccountResource()`.

## Actions

```
POST /accounting/vendor-bills/:purchaseId/action {action: "post"}     vendor-bill.actions.ts:postBillAction
  → reads purchase_orders by _id
  → vendorBillToPosting() contract → typed JE payload
      (Dr Inventory/Raw/Finished, Cr A/P 2111 with partnerId=supplier)
  → createPosting() persists + posts the JE
  → if `withholdVds:true` & supplier opts in:
        → buildCertificateData() in withholding-certificate.auto.ts
        → WithholdingCertificate.create({ journalEntryId, sourceId, ... })
  ← returns { journalEntryId, state }

POST /accounting/vendor-bills/:billJeId/action {action: "pay"}        vendor-bill.actions.ts:payBillAction
  → loadBillContext(billJeId) — resolves group key + open balance
  → assert amount ≤ open balance
  → vendorPaymentToPosting() (Dr A/P 2111, Cr Cash/Bank)
  → createPosting() persists + posts
  → maybeSettleGroup() — if net open = 0, atomically marks group `matched`
  ← returns { journalEntryId, state, settled }

POST /accounting/vendor-bills/:billJeId/action {action: "credit-note"} vendor-bill.actions.ts:creditNoteAction
  → idempotencyKey = `vendor-credit-note-${sourceId}-${ref}-${amount}`
  → if cached: return existing JE (silent dedup)
  → validateNoteInput() (reason min 3 chars, ref required)
  → vendorCreditNoteToPosting() (Dr A/P 2111, Cr Returns/Allowances)
  → maybeSettleGroup()
  ← returns { journalEntryId, state, matched, idempotent? }

POST /accounting/vendor-bills/bulk-pay {allocations: [...]}            vendor-bill.actions.ts:bulkPayHandler
  → pre-flight EVERY allocation against its bill's open balance (all-or-nothing)
  → max 50 allocations per call
  → per-allocation: vendorPaymentToPosting + createPosting + maybeSettleGroup
  ← returns { allocations: [...], totalPaid, billCount }
```

## Settlement model

A bill, its payments, and its credit notes share `sourceRef.sourceId + partnerId`.
None are individually marked `matched` — they're matched as a GROUP when
the net open balance is zero. Implemented in [`posting/open-balance.service.ts`](../../src/resources/accounting/posting/open-balance.service.ts):

- `computeOpenBalance(groupKey)` — sums credit-debit across the group
- `maybeSettleGroup(groupKey)` — if open=0, atomic mark-all-matched

This is why partial payments don't break: bill is `unmatched` until the LAST
payment lands and zeros it out.

## Files

| File | Purpose |
|---|---|
| [vendor-bill.resource.ts](../../src/resources/accounting/vendor-bill/vendor-bill.resource.ts) | resource declaration; uses `defineControlAccountResource` |
| [vendor-bill.actions.ts](../../src/resources/accounting/vendor-bill/vendor-bill.actions.ts) | post / pay / creditNote / bulkPay handlers |
| [_shared/control-account-resource.factory.ts](../../src/resources/accounting/_shared/control-account-resource.factory.ts) | shared factory (A/R + A/P mirror); auto-generates `/open` route, accepts `extraRoutes` for non-action endpoints |
| [posting/contracts/vendor-bill.contract.ts](../../src/resources/accounting/posting/contracts/vendor-bill.contract.ts) | typed JE payload builders |
| [posting/open-balance.service.ts](../../src/resources/accounting/posting/open-balance.service.ts) | `computeOpenBalance`, `maybeSettleGroup` |
| [withholding/withholding-certificate.auto.ts](../../src/resources/accounting/withholding/withholding-certificate.auto.ts) | auto-cert generation on bill post |

## Tests

- `tests/integration/shared/accounting-purchase-invoice-e2e.scenario.test.ts` — full procurement → AP lifecycle (31 tests)
- `tests/integration/shared/vendor-bill-bulk-pay.test.ts` — bulk-pay behavior (all-or-nothing pre-flight, 50-cap, empty rejection, happy path)
- `tests/unit/vendor-bill-bulk-pay-contract.test.ts` — contract guards on handler shape
- `tests/unit/withholding-auto-cert.test.ts` — VDS cert auto-creation

## Gotchas

- **Purchase totals are stored as BDT-major** (decimal). The posting contract
  multiplies by 100 to convert to paisa. Don't double-convert.
- **`bulkPay` does NOT wrap allocations in a transaction.** If the 5th of 10
  postings fails post-validation (very rare — pre-flight covers most cases),
  the first 4 stay posted. Pre-flight rejection (the common path) creates zero
  postings.
- **The `pay` action's `id` URL param is the BILL JE id**, not the purchase id.
  Different from `post` action which uses the purchase id.
- **`vendorBillResource` is NOT a standalone model.** Don't try to CRUD it — only
  the actions and the `/open` GET work. CRUD is disabled in the factory.
