# Finance API Guide (Backoffice)

Finance endpoints are designed for **accountants** and **backoffice staff** to export clean statements for Excel/Tally-style workflows.

## Roles

Default access is restricted to:
- `admin`, `superadmin`, `finance-admin`, `finance-manager`

## Export Statements

### Statement (CSV default)

```http
GET /api/v1/finance/statements?startDate=2025-12-01T00:00:00.000Z&endDate=2025-12-31T23:59:59.999Z&format=csv
```

Query params:
- `startDate`, `endDate` (ISO datetime)
- `branchId` (optional)
- `source` = `web|pos|api` (optional)
- `status` (optional)
- `format` = `csv|json` (default: `csv`)

Includes (when available):
- Branch code
- VAT invoice number (e.g. `INV-DHK-20251218-0001`)
- Payment reference (bKash/Nagad trx id)
- Order reference model/id

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
- `status` (optional; default includes finalized: verified/completed/refunded/partially_refunded)

Response shape:
- `data.totals`: income/expense/net/count (BDT)
- `data.byMethod`: method totals (cash/bkash/nagad/card…)
- `data.byDay[]`: per BD day + branch breakdown for UI tables
