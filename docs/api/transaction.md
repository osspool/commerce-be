### Transaction API Guide

This guide summarizes how the Transaction API behaves after the monetization/HRM updates, which fields the frontend may set, which are read-only, how income vs expense is determined, and what reports are available.

### Payment Flow (Monetization-managed Transactions)

Monetization workflows (membership, subscription) return both `transaction` and `paymentIntent`:

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
- **Monetization-managed (library)**: Created by workflows. Categories: `SUBSCRIPTION` (org expense), `MEMBERSHIP` (org income), `REFUND` (org expense). These map to slugs `platform_subscription`, `gym_membership`, `refund`.
- **HRM-managed (library)**: Created by HRM workflows. Categories: `SALARY`, `BONUS`, `COMMISSION`, `OVERTIME`, `SEVERANCE` (all expenses).
- **Manual operational (app)**: Created directly via Transactions API. Categories include `RENT`, `UTILITIES`, `EQUIPMENT`, `SUPPLIES`, `MAINTENANCE`, `MARKETING`, `OTHER_EXPENSE` (expenses) and `CAPITAL_INJECTION`, `RETAINED_EARNINGS`, `OTHER_INCOME` (income). `ADJUSTMENT` is special (type depends on amount sign).

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
- Create (manual only): `POST /api/v1/transactions` (admin only)
- Update: `PATCH /api/v1/transactions/:id`
- Delete: `DELETE /api/v1/transactions/:id` (pending manual only)
- Reports:
  - `GET /api/v1/transactions/reports/profit-loss`
  - `GET /api/v1/transactions/reports/categories`
  - `GET /api/v1/transactions/reports/cash-flow`

Monetization flows:
- Do NOT create transactions directly for subscriptions/memberships. They are created/updated by the monetization workflows and verified by the unified payment webhook system.
- Membership and subscription endpoints return both `transaction` and `paymentIntent` objects.
- Use `paymentIntent.instructions` to display payment details to customers (manual payments).
- Use `paymentIntent.clientSecret` or `transaction.gateway.paymentUrl` for gateway payments (future).

### Fields: what FE can set vs read-only

**Immutable fields (all transactions):**
- `organizationId`, `customerId`, `referenceId`, `referenceModel`, `type`, `category`

**System-managed fields (all transactions):**
- `commission`, `gateway`, `webhook`, `verifiedAt`, `verifiedBy`, `metadata`

**Library-managed transactions (subscription, membership, refund, salary, bonus, commission, overtime, severance):**
- Create: Blocked (managed by workflows)
- Update: Only `notes` allowed; `status` blocked (webhooks only)

**Manual transactions (rent, utilities, equipment, capital_injection, etc.):**
- Create: `category`, `amount`, `method`, `reference`, `paymentDetails`, `notes`, `date`, `status` (optional)
  - `type` auto-derived from `category`
  - `status` defaults to `pending`
- Update (pending): `status`, `amount`, `method`, `reference`, `paymentDetails`, `notes`, `date`
- Update (verified/completed): `status`, `notes`, `reference`, `paymentDetails`

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
  "method": "bkash | nagad | rocket | bank | card | online | manual | cash",
  "gateway": {                          // read-only
    "type": "manual | stripe | sslcommerz | bkash_gateway | nagad_gateway",
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
  "provider": "manual | stripe | sslcommerz | bkash_gateway | nagad_gateway",
  "status": "pending | processing | succeeded | failed | cancelled",
  "instructions": {                     // manual payments only
    "bkash": "01712345678 (Personal)",
    "nagad": "01812345678 (Merchant)",
    "bank": "ABC Bank - 1234567890",
    "reference": "Use code: MEM-2025-001",
    "note": "Pay to XYZ Gym. Operating hours: 6 AM - 10 PM"
  },
  "clientSecret": "string | null",      // Stripe SDK payments
  "metadata": {}
}
```

Create manual transaction (request body):
```json
{
  "category": "rent | utilities | equipment | supplies | maintenance | marketing | other_expense | capital_injection | retained_earnings | other_income | adjustment",
  "amount": 50000,
  "method": "bank | bkash | nagad | rocket | cash | manual | card | online",
  "reference": "string",
  "paymentDetails": {
    "bankName": "string",
    "accountNumber": "string",
    "accountName": "string",
    "walletNumber": "string",
    "walletType": "personal | merchant",
    "proofUrl": "string"
  },
  "date": "2025-11-01T00:00:00.000Z",
  "notes": "string"
}
```

Update manual transaction (status=pending):
```json
{
  "amount": 52000,
  "method": "bank",
  "reference": "TT-2025-11-01",
  "paymentDetails": { "bankName": "ABC Bank" },
  "date": "2025-11-02T00:00:00.000Z",
  "notes": "Updated note"
}
```

### Supported enums (import from `@classytic/revenue/enums`)
- **TRANSACTION_STATUS**: `pending`, `payment_initiated`, `processing`, `requires_action`, `verified`, `completed`, `failed`, `cancelled`, `expired`, `refunded`, `partially_refunded`.
- **PAYMENT_METHOD**: `bkash`, `nagad`, `rocket`, `bank`, `card`, `online`, `manual`, `cash`.
- **PAYMENT_GATEWAY_TYPE**: `manual`, `stripe`, `sslcommerz`, `bkash_gateway`, `nagad_gateway`.
- **LIBRARY_TRANSACTION_CATEGORIES** (system-managed):
  - `SUBSCRIPTION` → `platform_subscription` (expense)
  - `MEMBERSHIP` → `gym_membership` (income)
  - `REFUND` → `refund` (expense)
- **HRM categories** (system-managed): `salary`, `bonus`, `commission`, `overtime`, `severance`.
- **Manual categories** (create via API): `rent`, `utilities`, `equipment`, `supplies`, `maintenance`, `marketing`, `other_expense`, `capital_injection`, `retained_earnings`, `other_income`, `adjustment`.

Notes:
- `type` is derived from `category` server-side. Do not send `type` unless necessary.
- Library-managed categories cannot be created manually; only `notes` can be updated.

### Create manual transaction (example)
Request (owner/manager/admin with org context):
```json
POST /api/v1/transactions
{
  "category": "rent",
  "amount": 50000,
  "method": "bank",
  "reference": "TT-2025-11-01",
  "paymentDetails": { "bankName": "ABC Bank", "accountNumber": "123456" },
  "date": "2025-11-01T00:00:00.000Z",
  "notes": "November office rent"
}
```
Behavior:
- Backend validates category is manual (not monetization/HRM), derives `type`=`expense`, injects `organizationId` from context, and sets `status`=`pending`.

### Income vs Expense in UI
- Use `type` to render Income/Expense badges and groupings.
- For category display, use the friendly key (e.g., `SUBSCRIPTION`, `MEMBERSHIP`, `RENT`) and/or a localized label.

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
- Platform subscription (`platform_subscription`) is an organization **expense**.
- Membership sales (`gym_membership`) are organization **income**.
- Commission tracked in `commission` object for gateway payments.
- All immutable fields protected at schema + controller level.
- **Status**: Library-managed = webhooks only; Manual = user can update.


