### Transaction API Guide

This guide summarizes how the Transaction API behaves in this ecommerce backend: which fields are read-only, how income vs expense is determined, and what reports are available.

**Important:** Transactions are created by order/POS flows via `@classytic/revenue` or by internal operational workflows (inventory loss/purchase, COGS, etc.). Manual creation is allowed for staff users.

### Payment Flow (Order/POS Transactions)

Order flows return both `transaction` and `paymentIntent`:

**Manual Payments:**
- `paymentIntent.instructions` contains formatted payment details (bKash, Nagad, bank accounts)
- Display instructions to customer immediately
- Customer pays offline → Admin verifies via webhook

**Gateway Payments (future):**
- Stripe: Use `paymentIntent.clientSecret` with Stripe SDK
- Other gateways: Redirect to `paymentIntent.paymentUrl` (if provided by provider)
- Webhook auto-verifies on payment completion

**Polling:**
- Poll transaction status or listen to real-time updates after displaying instructions

### Transaction types and categories
- **Order/POS (library)**: Created via `revenue.monetization.create()` for `purchase` flows.
- **Operational (app)**: Created internally for inventory flows (purchase, loss, adjustment, COGS) using the same Transaction model.

App category reference (`#common/revenue/enums.js`):
`order_purchase`, `order_subscription`, `inventory_purchase`, `purchase_return`, `inventory_loss`, `inventory_adjustment`, `cogs`, `rent`, `utilities`, `equipment`, `supplies`, `maintenance`, `marketing`, `other_expense`, `capital_injection`, `retained_earnings`, `tip_income`, `other_income`, `wholesale_sale`, `platform_subscription`, `creator_subscription`, `enrollment_purchase`, `enrollment_subscription`.

### Accounting Model: Cashflow vs. Double-Entry
This system uses a **Cashflow Event** model by default:
- **Income**: Sales, Capital Injection, Memberships
- **Expense**: Rent, Salaries, Inventory Purchases, Marketing
- **COGS**: Calculated on-demand or optionally recorded as 'cogs' transactions (opt-in).

**Why not double-entry?**
For retail speed and simplicity, we track money-in/money-out events. Accountants should use the **Statement Export** to import these events into dedicated accounting software (QuickBooks/Tally/Xero) for formal double-entry ledgers.

**Amount Fields (Unified Semantics):**

| Field | Meaning | Example (1000 BDT sale, 15% VAT-inclusive) |
|-------|---------|-------------------------------------------|
| `amount` | Stored amount in smallest unit (see note below) | 100000 paisa |
| `fee` | Platform/gateway fees deducted | 0 (manual payment) |
| `tax` | VAT/tax portion (informational) | 13043 paisa (extracted VAT) |
| `net` | `amount - fee - tax` (derived) | 86957 paisa |

**Important:** `tax` is stored for reporting. `net` subtracts both fees and tax so finance reports can reason about post-tax net values.
- For VAT-inclusive pricing, the revenue library may store `amount` as a base amount and keep VAT in `tax`.
- For VAT-exclusive pricing, `amount` reflects the pre-tax base and VAT is still tracked in `tax`.
- Use `amount` for cashflow totals and `tax` fields for VAT reporting.
- Query `sum(tax) where flow='inflow'` → Output VAT (collected from customers)
- Query `sum(tax) where flow='outflow' and type='inventory_purchase'` → Input VAT (paid to suppliers)
- Net VAT liability = Output VAT - Input VAT

**Transaction Schema (v1.1.0+):**

The transaction model uses two key fields for classification:
- `flow`: Direction of money (`'inflow'` = money in, `'outflow'` = money out)
- `type`: Category of transaction (`order_purchase`, `refund`, `inventory_purchase`, etc.)

The `flow` field determines whether a transaction is income (inflow) or expense (outflow). The `type` field provides the business category for reporting.

Notable: Operational expenses (inventory_purchase, cogs, rent) have `flow: 'outflow'`. Refunds also have `flow: 'outflow'`.

### Tax/VAT Support in Transactions

Transactions include tax fields for finance/accounting reporting. Tax data flows from source documents (Orders, Purchases) to transactions automatically.

**Tax Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `tax` | number | Tax amount in smallest unit (paisa). For VAT-inclusive pricing, this is the extracted VAT. |
| `taxDetails` | object | Structured tax metadata for reporting |
| `taxDetails.type` | string | Tax type: `'vat'`, `'gst'`, `'sales_tax'` |
| `taxDetails.rate` | number | Tax rate as decimal (0.15 = 15%) |
| `taxDetails.isInclusive` | boolean | Whether prices include tax (BD default: true) |
| `taxDetails.jurisdiction` | string | Tax jurisdiction code (e.g., `'BD'` for Bangladesh) |

**Tax Data Flow:**

| Source | Tax Origin | Transaction Tax |
|--------|------------|-----------------|
| **Order (Web)** | `order.vat.amount` | Populated when transaction is created |
| **Order (POS)** | `order.vat.amount` | Populated via background job |
| **Purchase** | `purchase.taxTotal` | Populated on payment |
| **Refund** | Proportional to refund | Auto-calculated from original transaction |

**Partial Refund Tax Calculation:**
```
refundTax = originalTax × (refundAmount / originalAmount)
```

**Example Transaction with Tax:**
```json
{
  "_id": "txn_id",
  "flow": "inflow",
  "type": "order_purchase",
  "amount": 230000,
  "tax": 30000,
  "net": 200000,
  "taxDetails": {
    "type": "vat",
    "rate": 0.15,
    "isInclusive": true,
    "jurisdiction": "BD"
  }
}
```

**Tax Reporting Queries:**
```javascript
// Aggregate VAT from verified inflow transactions
db.transactions.aggregate([
  { $match: { flow: 'inflow', status: 'verified', 'taxDetails.type': 'vat' } },
  { $group: { _id: null, totalVat: { $sum: '$tax' }, count: { $sum: 1 } } }
]);

// Net VAT (collected - refunded)
// Inflow VAT - Outflow refund VAT = Net VAT liability
```

### Endpoints
- List: `GET /api/v1/transactions`
- Get: `GET /api/v1/transactions/:id`
- Create: **Allowed** (manual entry)
- Update: `PATCH /api/v1/transactions/:id` (limited corrections)
- Delete: **Allowed for admin/superadmin only**
- Reports:
  - `GET /api/v1/transactions/reports/profit-loss`
  - `GET /api/v1/transactions/reports/categories`
  - `GET /api/v1/transactions/reports/cash-flow`

Monetization flows:
- Do NOT create transactions directly; they are created/updated by order/POS workflows and verified by the payment webhook system.
- Order endpoints return both `transaction` and `paymentIntent` objects.
- Use `paymentIntent.instructions` to display payment details to customers (manual payments).
- Use `paymentIntent.clientSecret` or `paymentIntent.paymentUrl` for gateway payments (future).

### Fields: what FE can set vs read-only

**Immutable fields (all transactions):**
- `customerId`, `sourceId`, `sourceModel`

**System-managed fields (all transactions):**
- `commission`, `gateway`, `webhook`, `verifiedAt`, `verifiedBy`

**Editable correction fields (permissioned):**
- `flow`, `type`, `amount`, `fee`, `tax`, `net`, `taxDetails`, `method`, `paymentDetails`, `branch`, `branchCode`, `source`, `notes`, `description`, `metadata`

**All transactions in this app are library/flow-managed by default:**
- Create: Manual entries are allowed for staff users (permissioned)
- Update: Limited corrections allowed (permissioned)

### Customer Transactions

Transactions store `customerId` for order flows. Walk-in/guest orders may keep `customerId: null`.

Two supported approaches:

1) **From Orders**
- Query orders by `customer` or `customerPhone`
- For each order, read `currentPayment.transactionId` (if present)
- Fetch the transaction via `GET /api/v1/transactions/:id`

2) **Statement Export**
- `GET /api/v1/transactions/statement?...&format=json`
- Includes `orderCustomerName` when the transaction references an Order

### Schemas (FE contract)

Transaction object (response shape; selected fields). Single-tenant app: `organizationId` is omitted.
```json
{
  "_id": "ObjectId",
  "customerId": "ObjectId | null",
  "handledBy": "ObjectId | null",
  "flow": "inflow | outflow",           // money direction (read-only)
  "type": "string",                     // category: order_purchase, refund, inventory_purchase, etc.
  "status": "pending | payment_initiated | processing | requires_action | verified | completed | failed | cancelled | expired | refunded | partially_refunded",
  "amount": 12345,                      // gross amount in smallest unit (paisa)
  "fee": 0,                             // gateway/platform fees
  "tax": 0,                             // tax amount in smallest unit (paisa)
  "net": 12345,                         // net amount after fees/tax
  "method": "cash | bkash | nagad | rocket | bank_transfer | card | online | manual | split",
  "gateway": {                          // read-only
    "type": "manual | stripe | sslcommerz | <custom>",
    "provider": "manual | stripe | sslcommerz | <custom>",
    "sessionId": "string | null",
    "paymentIntentId": "string | null",
    "metadata": {}
  },
  "paymentDetails": {                   // editable rules vary by type/status
    "walletNumber": "string",
    "walletType": "personal | merchant",
    "trxId": "string",
    "bankName": "string",
    "accountNumber": "string",
    "accountName": "string",
    "proofUrl": "string",
    "payments": [
      {
        "method": "cash | bkash | nagad | bank_transfer | card | online",
        "amount": 5000,
        "reference": "string",
        "details": {}
      }
    ]
  },
  "taxDetails": {                       // tax breakdown for finance (read-only)
    "type": "vat | gst | sales_tax",
    "rate": 0.15,                       // decimal (15% = 0.15)
    "isInclusive": true,                // prices include tax
    "jurisdiction": "BD"                // tax jurisdiction
  },
  "notes": "string",
  "date": "ISO 8601",
  "source": "web | pos | api",          // transaction origin
  "branch": "ObjectId | null",          // branch reference
  "branchCode": "string | null",        // branch code for display
  "commission": {                        // read-only; monetization-calculated
    "rate": 0.04,
    "grossAmount": 500,
    "gatewayFeeRate": 0.029,
    "gatewayFeeAmount": 290,
    "netAmount": 210,
    "status": "pending | paid | waived | reversed"
  },
  "sourceModel": "Order | Purchase | Manual",    // polymorphic reference (read-only)
  "sourceId": "ObjectId",                        // source document ID (read-only)
  "verifiedAt": "ISO 8601 | null",               // read-only
  "verifiedBy": "ObjectId | null"                 // read-only
}
```

PaymentIntent object (returned with monetization-managed transactions):
```json
{
  "id": "string",
  "provider": "manual | stripe | sslcommerz | <custom>",
  "status": "pending | processing | succeeded | failed | cancelled",
  "instructions": {                     // manual payments only
    "bkash": "01712345678 (Personal)",
    "nagad": "01812345678 (Merchant)",
    "bank": "ABC Bank - 1234567890",
    "reference": "Use code: ORD-2025-001",
    "note": "Pay to XYZ Gym. Operating hours: 6 AM - 10 PM"
  },
  "clientSecret": "string | null",      // Stripe SDK payments
  "paymentUrl": "string | null",        // Redirect URL for hosted payment pages
  "metadata": {}
}
```

> Manual creation is allowed. Updates are limited to correction fields listed above.

### Supported enums (import from `@classytic/revenue/enums` and `#shared/revenue/enums.js`)
- **TRANSACTION_FLOW**: `inflow`, `outflow` - direction of money
- **TRANSACTION_STATUS**: `pending`, `payment_initiated`, `processing`, `requires_action`, `verified`, `completed`, `failed`, `cancelled`, `expired`, `refunded`, `partially_refunded`
- **PAYMENT_METHOD**: `cash`, `bkash`, `nagad`, `rocket`, `bank_transfer`, `card`, `online`, `manual`, `split`
- **PAYMENT_GATEWAY_TYPE**: `manual`, `stripe`, `sslcommerz` (custom values allowed)
- **TRANSACTION_CATEGORY** (type values): `order_purchase`, `refund`, `subscription`, `purchase`, `inventory_purchase`, `cogs`, `inventory_loss`, etc. (see `#shared/revenue/enums.js`)

Notes:
- `flow` and `type` are set automatically based on the transaction source (Order, Purchase, etc.).
- `type` contains the category (e.g., `order_purchase`, `refund`). Do not confuse with `flow` which indicates direction.
- Library-managed transactions cannot be created manually; only `notes` can be updated.

### Income vs Expense in UI
- Use `flow` to render Income/Expense badges: `'inflow'` = Income (green), `'outflow'` = Expense (red)
- Use `type` for category display (e.g., `order_purchase`, `inventory_purchase`, `refund`, `rent`)
- For groupings and reports, filter by `flow` first, then optionally by `type` for sub-categories

### Financial reports
- Profit & Loss: totals income (`flow: 'inflow'`) and expenses (`flow: 'outflow'`) using `amount`.
- Categories breakdown: top categories grouped by `type`, optionally filtered by `flow` (uses `amount`).
- Cash flow: monthly trend of inflow vs outflow (uses `amount`).
- For post-fee/tax analysis, use `net` instead of `amount` in custom queries.

### Statement export (accountant-friendly)

Use this when you want a clean export for Excel/Tally-style imports:

- `GET /api/v1/transactions/statement?startDate=...&endDate=...&branchId=...&format=csv`

Includes (when available):
- Branch code
- Order VAT invoice number (`INV-{BRANCHCODE}-{YYYYMMDD}-{NNNN}`)
- Payment reference / trx id (from metadata/paymentDetails)

Note: This is a transaction statement (a financial log), not a full double-entry ledger.

### Notes
- Commission tracked in `commission` object for gateway payments.
- All immutable fields are protected at schema + controller level.
- **Status**: managed by payment workflows/webhooks; client updates are limited to `notes`.
