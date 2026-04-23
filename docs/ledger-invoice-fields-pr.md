# PR: Reconciliation Events + Invoice Integration Points

**Package:** `@classytic/ledger`
**Priority:** Medium — enables upcoming `@classytic/invoice` package integration
**Breaking:** No — additive only

---

## Context

We're building a composable ERP with a dedicated `@classytic/invoice` package (document layer) that sits between commerce/orders and the ledger (accounting layer). The invoice package will own:
- Sequential invoice/bill numbering
- Line items (product, qty, price, tax)
- Payment state tracking (not_paid / partial / paid)
- Tax calculation orchestration (via pluggable TaxCalculator port)

The ledger remains the **accounting source of truth** — journal entries, double-entry, reconciliation, reports. It does NOT need invoice-specific fields (moveType, invoiceNumber, lineItems). Those belong in the invoice package.

What ledger needs to enable this integration:

---

## Proposed Changes

### 1. Reconciliation lifecycle events

When `reconciliations.match()` or `reconciliations.unmatch()` completes, emit events that the invoice package (or any consumer) can subscribe to:

```typescript
// After successful match
engine.events.emit('reconciliation.matched', {
  matchId: string;
  journalEntryIds: string[];
  accountId: string;
  // For each matched item: entryId, itemIndex, amount matched
  items: Array<{
    journalEntryId: string;
    itemIndex: number;
    amount: number;
    fullySettled: boolean; // true if item's open balance is now 0
  }>;
});

// After unmatch
engine.events.emit('reconciliation.unmatched', {
  matchId: string;
  journalEntryIds: string[];
});
```

**Why:** The invoice package listens for `reconciliation.matched` to auto-update invoice `paymentState`. Currently BigBoss manually tracks this in `customer-invoice.actions.ts` — fragile and duplicative.

### 2. `sourceRef` as a first-class schema option (not just extraFields)

Currently consumers add `sourceRef` via `extraFields`. Promote it to a built-in opt-in field:

```typescript
createAccountingEngine({
  schemaOptions: {
    journalEntry: {
      sourceRef: true, // Adds { sourceModel: String, sourceId: ObjectId } with sparse index
    },
  },
});
```

**Why:** Every consumer that integrates invoicing, orders, or external documents needs this. Making it built-in ensures consistent indexing and typing.

### 3. Open items query helper on repository

Add a dedicated method for querying unmatched (open) journal items on a control account:

```typescript
// Existing: consumers build this aggregation manually
// Proposed: first-class repository method
journalEntries.getOpenItems({
  accountId: string;           // Control account (A/R or A/P)
  partnerId?: string;          // Filter by partner
  organizationId?: ObjectId;   // Branch filter
  asOfDate?: Date;             // Point-in-time balance
}): Promise<OpenItem[]>

interface OpenItem {
  journalEntryId: string;
  itemIndex: number;
  date: Date;
  reference: string;
  partnerId?: string;
  originalAmount: number;      // Full debit or credit
  matchedAmount: number;       // Already reconciled
  openAmount: number;          // Remaining
  sourceRef?: { sourceModel: string; sourceId: string };
}
```

**Why:** BigBoss, and any future consumer with A/R or A/P, needs this query. Currently implemented in `customer-invoice.actions.ts` as a raw aggregation. Belongs in the engine.

### 4. Aged balance report: accept `sourceRef` grouping

Extend `generateAgedBalance()` to optionally group by `sourceRef.sourceId` (invoice ID) in addition to partnerId:

```typescript
generateAgedBalance({
  side: 'receivable' | 'payable';
  asOfDate?: Date;
  groupBy?: 'partner' | 'source' | 'both'; // NEW: default 'partner'
  organizationId?: ObjectId;
  buckets?: number[]; // default [30, 60, 90]
})
```

**Why:** When the invoice package exists, aging by invoice (source) is the standard view. Currently only partner-level aging is available.

---

## What This Does NOT Include

- Invoice model/schema — that's `@classytic/invoice`'s concern
- Sequential numbering — invoice package
- Tax calculation — future `@classytic/bd-tax` or `@classytic/tax`
- Payment state tracking — invoice package (consuming reconciliation events)
- PDF generation — consumer/presentation layer
- Line items with product/qty/price — invoice package

---

## Test Plan

- [ ] `reconciliation.matched` event fires with correct payload after `match()`
- [ ] `reconciliation.unmatched` event fires after `unmatch()`
- [ ] `sourceRef: true` adds the field with sparse index
- [ ] `getOpenItems()` returns correct open balances for a control account
- [ ] `getOpenItems()` respects `partnerId` and `asOfDate` filters
- [ ] `generateAgedBalance({ groupBy: 'source' })` groups by sourceRef
- [ ] All existing tests still pass (no breaking changes)

---

## Integration Flow (how it all connects)

```
Order Service (be-prod)
  │
  ├─ Prepaid (card/cash):
  │    Order → @classytic/revenue (payment) → @classytic/ledger (JE: debit cash, credit revenue)
  │    No invoice. Receipt generated by revenue package.
  │
  └─ Credit (B2B, charge-to-account):
       Order → @classytic/invoice (creates Invoice document)
                 │
                 ├─ Invoice.post() → calls LedgerBridge
                 │    → @classytic/ledger (JE: debit A/R, credit revenue + sourceRef → invoice._id)
                 │
                 └─ Later: Payment received
                      → @classytic/revenue (payment confirmed)
                      → @classytic/ledger (JE: debit cash, credit A/R)
                      → ledger reconciliation.match() → emits 'reconciliation.matched'
                      → @classytic/invoice listens → updates invoice.paymentState = 'paid'
```
