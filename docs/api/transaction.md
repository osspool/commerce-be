### Transaction API Guide

This guide summarizes how the Transaction API behaves in this ecommerce backend: which fields are read-only, how income vs expense is determined, and what reports are available.

**Important:** Transactions are **not created manually** in this app. They are created by order/POS flows via `@classytic/revenue` or by internal operational workflows (inventory loss/purchase, COGS, etc.). `POST /api/v1/transactions` is blocked.

### Payment Flow (Order/POS Transactions)

Order flows return both `transaction` and `paymentIntent`:

**Manual Payments:**
- `paymentIntent.instructions` contains formatted payment details (bKash, Nagad, bank accounts)
- Display instructions to customer immediately
- Customer pays offline → Admin verifies via webhook

**Gateway Payments (future):**
- Stripe: Use `paymentIntent.clientSecret` with Stripe SDK
- Other gateways: Redirect to `transaction.gateway.paymentUrl`
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

Type inference:
- The backend derives `type` automatically from `category` (income vs expense). The frontend should not need to compute `type`.
- Notable: `SUBSCRIPTION` is an expense for organizations (platform fee paid to us).

### Endpoints
- List: `GET /api/v1/transactions`
- Get: `GET /api/v1/transactions/:id`
- Create: **Blocked** (transactions are created by order/POS/operational workflows)
- Update: `PATCH /api/v1/transactions/:id` (**notes only**)
- Delete: **Blocked** (immutable for accounting)
- Reports:
  - `GET /api/v1/transactions/reports/profit-loss`
  - `GET /api/v1/transactions/reports/categories`
  - `GET /api/v1/transactions/reports/cash-flow`

Monetization flows:
- Do NOT create transactions directly; they are created/updated by order/POS workflows and verified by the payment webhook system.
- Order endpoints return both `transaction` and `paymentIntent` objects.
- Use `paymentIntent.instructions` to display payment details to customers (manual payments).
- Use `paymentIntent.clientSecret` or `transaction.gateway.paymentUrl` for gateway payments (future).

### Fields: what FE can set vs read-only

**Immutable fields (all transactions):**
- `organizationId`, `customerId`, `referenceId`, `referenceModel`, `type`, `category`

**System-managed fields (all transactions):**
- `commission`, `gateway`, `webhook`, `verifiedAt`, `verifiedBy`, `metadata`

**All transactions in this app are library/flow-managed:**
- Create: Blocked (system-managed)
- Update: Only `notes` allowed

### Customer Transactions

Transactions are linked to customers **via Order references**, not a direct `customerId` field on Transaction.

Two supported approaches:

1) **From Orders**
- Query orders by `customer` or `customerPhone`
- For each order, read `currentPayment.transactionId` (if present)
- Fetch the transaction via `GET /api/v1/transactions/:id`

2) **Statement Export**
- `GET /api/v1/transactions/statement?...&format=json`
- Includes `orderCustomerName` when the transaction references an Order

### Schemas (FE contract)

Transaction object (response shape; selected fields):
```json
{
  "_id": "ObjectId",
  "organizationId": "ObjectId",
  "customerId": "ObjectId | null",
  "handledBy": "ObjectId | null",
  "type": "income | expense",          // derived from category (read-only)
  "category": "string",                // see enums below (immutable after creation)
  "status": "pending | payment_initiated | processing | requires_action | verified | completed | failed | cancelled | expired | refunded | partially_refunded",
  "amount": 12345,                      // immutable after creation
  "method": "cash | bkash | nagad | rocket | bank_transfer | card | online | manual",
  "gateway": {                          // read-only
    "type": "manual | stripe | sslcommerz | <custom>",
    "paymentUrl": "string | null"       // redirect URL for gateway payments
  },
  "reference": "string",
  "paymentDetails": {                   // editable rules vary by type/status
    "walletNumber": "string",
    "walletType": "personal | merchant",
    "bankName": "string",
    "accountNumber": "string",
    "accountName": "string",
    "proofUrl": "string"
  },
  "notes": "string",
  "date": "ISO 8601",
  "commission": {                        // read-only; monetization-calculated
    "rate": 0.04,
    "grossAmount": 500,
    "gatewayFeeRate": 0.029,
    "gatewayFeeAmount": 290,
    "netAmount": 210,
    "status": "pending | due | paid | waived",
    "dueDate": "ISO 8601"
  },
  "referenceModel": "Subscription | Membership | Employee | Organization | User", // read-only
  "referenceId": "ObjectId",                                                          // read-only
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
  "metadata": {}
}
```

> Manual creation is blocked. Only `notes` updates are allowed via PATCH.

### Supported enums (import from `@classytic/revenue/enums` and `#common/revenue/enums.js`)
- **TRANSACTION_STATUS**: `pending`, `payment_initiated`, `processing`, `requires_action`, `verified`, `completed`, `failed`, `cancelled`, `expired`, `refunded`, `partially_refunded`.
- **PAYMENT_METHOD**: `cash`, `bkash`, `nagad`, `rocket`, `bank_transfer`, `card`, `online`, `manual`.
- **PAYMENT_GATEWAY_TYPE**: `manual`, `stripe`, `sslcommerz` (custom values allowed).
- **App categories**: see `#common/revenue/enums.js` list above.

Notes:
- `type` is derived from `category` server-side. Do not send `type` unless necessary.
- Library-managed categories cannot be created manually; only `notes` can be updated.

### Income vs Expense in UI
- Use `type` to render Income/Expense badges and groupings.
- For category display, use the friendly key (e.g., `order_purchase`, `inventory_loss`, `rent`) and/or a localized label.

### Financial reports
- Profit & Loss: totals income, expenses, net profit for date range.
- Categories breakdown: top categories filtered by `type`=`income` or `expense` (optional).
- Cash flow: monthly trend of income vs expense and net.

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


