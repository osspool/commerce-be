# Finance API Guide (Backoffice)

Finance endpoints are designed for **accountants** and **backoffice staff** to export clean statements for Excel/Tally-style workflows.

## Roles

Default access is restricted to:
- `admin`, `superadmin`, `finance-admin`, `finance-manager`

## Transaction Schema Reference

Finance reports use the unified transaction schema:
- `flow`: Direction of money (`'inflow'` = income, `'outflow'` = expense)
- `type`: Category (`order_purchase`, `refund`, `inventory_purchase`, `cogs`, etc.)
- `tax`: Tax amount in paisa (smallest unit)
- `taxDetails`: Tax metadata (`type`, `rate`, `isInclusive`, `jurisdiction`)

See [Transaction API](transaction.md) for full schema details.

## Export Statements

### Statement (CSV default)

```http
GET /api/v1/finance/statements?startDate=2025-12-01T00:00:00.000Z&endDate=2025-12-31T23:59:59.999Z&format=csv
```

Query params:
- `startDate`, `endDate` (ISO datetime)
- `branchId` (optional)
- `source` = `web|pos|api` (optional)
- `flow` = `inflow|outflow` (optional - filter by direction)
- `status` (optional)
- `format` = `csv|json` (default: `csv`)

Includes (when available):
- Branch code
- VAT invoice number (e.g. `INV-DHK-20251218-0001`)
- Payment reference (bKash/Nagad trx id)
- Source reference (`sourceModel`/`sourceId`)
- Tax amount and tax details

This is a statement export (financial log), not a full double-entry ledger export.

## Finance Summary (Dashboard)

### Summary (BD day + branch + method)

```http
GET /api/v1/finance/summary?startDate=2025-12-01T00:00:00.000Z&endDate=2025-12-31T23:59:59.999Z
```

Query params:
- `startDate`, `endDate` (ISO datetime)
- `branchId` (optional)
- `source` = `web|pos|api` (optional)
- `flow` = `inflow|outflow` (optional)
- `status` (optional; default includes finalized: verified/completed/refunded/partially_refunded)

Response shape:
- `data.totals`: inflow/outflow/net/count (BDT) - income and expense totals
- `data.byMethod`: method totals (cash/bkash/nagad/card…)
- `data.byDay[]`: per BD day + branch breakdown for UI tables
- `data.taxSummary`: VAT/tax breakdown (if applicable)

## VAT Reporting

### VAT Summary Query

```http
GET /api/v1/finance/summary?startDate=...&endDate=...
```

The summary includes VAT breakdown:
- **Output VAT** (collected): From `flow: 'inflow'` transactions with `taxDetails.type: 'vat'`
- **Input VAT** (paid): From `flow: 'outflow'` transactions with `type: 'inventory_purchase'`
- **Refund VAT**: From `flow: 'outflow'` transactions with `type: 'refund'`
- **Net VAT Liability**: Output VAT - Input VAT - Refund VAT

### Example VAT Aggregation

```javascript
// MongoDB aggregation for VAT reporting
db.transactions.aggregate([
  { $match: {
    date: { $gte: startDate, $lte: endDate },
    status: { $in: ['verified', 'completed'] },
    'taxDetails.type': 'vat'
  }},
  { $group: {
    _id: '$flow',
    totalTax: { $sum: '$tax' },
    count: { $sum: 1 }
  }}
]);
```
