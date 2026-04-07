# Production Setup Guide (Bangladesh Retail: Ecom + POS + Warehouse)

This project implements a Bangladesh retail inventory model:

- **Head Office (Warehouse)** is the only place new stock enters the system (purchases).
- **Challan/Transfers** move stock from Head Office to stores.
- **POS** decrements stock immediately at checkout.
- **Ecom/Web** reserves stock at checkout and decrements at fulfillment.

This guide is written for **MongoDB Atlas** and the existing role model:

- `admin`, `superadmin`
- `warehouse-admin` (Head office stock + challans + approvals)
- `warehouse-staff` (Warehouse operations)
- `store-manager` (POS + receive challans + local decrease/recount adjustments)
- `finance-admin` (cost/margin visibility + approvals)
- `finance-manager` (cost/margin visibility + reports)

---

## 1) MongoDB Atlas (Transactions + Reliability)

### Why Atlas is the right choice here
This backend uses transaction-capable flows for inventory safety (reservation/commit, batch decrement/restore). MongoDB transactions require a replica set; Atlas already provides that.

### Atlas checklist (recommended)
- Cluster: **Replica set** (standard Atlas cluster).
- Region: close to Bangladesh users (commonly `ap-south-1` / Mumbai) for latency.
- Backups: enable **Continuous Backup / PITR** if your plan supports it.
- Monitoring: enable Atlas alerts (CPU, memory, connections, disk, oplog).

### Connection string (required env)
Set `MONGO_URI` in your deployment environment.

- Example: `MONGO_URI=mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/DBNAME?retryWrites=true&w=majority`
- Keep `retryWrites=true` and `w=majority` (safer write durability).

---

## 2) Data Protection (Backup/Restore)

### Minimum standard
- Daily automated backup (or PITR).
- Monthly restore drill: restore into a separate "staging restore" DB and verify:
  - orders exist
  - stock entries exist
  - latest challans exist

### What you must be able to recover
- Orders + payments
- StockEntry + StockMovement audit trail
- Transfers (challans)
- Products + variants

---

## 3) Branch Bootstrap (Head Office + Default Branch)

### Core rule
There must be exactly one `Branch.role=head_office` and at least one active branch marked `isDefault=true`.

### Setup steps
1. Create your branches using the Branch API.
2. Set the warehouse branch to `role=head_office`.
3. Set the primary selling branch to `isDefault=true` (optional but recommended).

### Why this matters
Many flows fall back to default branch when branch isn't provided. If the default branch is wrong, you can:
- reserve/decrement stock in the wrong branch
- compute wrong profit (branch-specific cost lookup)

---

## 4) Inventory Standard (Single Source of Truth)

### Standard used in this codebase
- **Cost of goods (COGS)** is maintained at head office inventory and propagated.
- **Product/variant `costPrice`** is treated as a **read-only snapshot** for fast reads/fallback.
- Transfers inherit cost from sender stock; stores do not "invent" cost locally.

### What your warehouse should do
- Use **Purchases** to add stock and set `items[].costPrice`.
- Use **Transfers (Challan)** to distribute stock to branches.

### What stores should do
- Use **POS** for sales (immediate decrement).
- Use **Receive Challan** for incoming stock.
- Use **Adjustments** for recount/loss/damage only (not as a "stock in" mechanism).

---

## 5) Web/Ecom Stock Handling (Reservation)

### What happens at checkout
- Validate branch stock
- Create a **reservation** (increments `StockEntry.reservedQuantity`)
- Do not decrement physical stock yet

### What happens at fulfillment
- Commit reservation (decrements quantity and reservedQuantity)
- Create sale movements

### Why this is standard
It prevents oversells in e-commerce where many users can checkout at the same time.

---

## 6) POS Stock Handling (Immediate Decrement)

### Standard behavior
- POS validates available stock and decrements immediately (no reservation).
- POS pricing is computed server-side to prevent tampering.

### POS transaction durability (EventOutbox)
POS sale events are persisted to a MongoDB-backed **EventOutbox** before delivery. A cron relay (every 5 seconds) retries any undelivered events, guaranteeing at-least-once processing even if the server restarts mid-transaction.

### Operational recommendations (BD reality)
- Always send `idempotencyKey` from POS terminals so network retries don't create duplicate sales (multi-instance safe; stored with TTL).
- Keep terminal identifiers stable per device (`terminalId`).

### Money units (important)
- `Order.totalAmount`, `StockEntry.costPrice`, and most business-facing amounts are stored/handled in **BDT**.
- `Transaction.amount` is stored in the **smallest unit** (paisa) per `src/resources/transaction/transaction.model.ts` and `@classytic/revenue`.

---

## 7) Roles & Permissions (Operational Safety)

### Recommended responsibilities
- `warehouse-admin`
  - record purchases at head office
  - create/approve/dispatch challans
- `warehouse-staff`
  - receive stock at head office
  - prepare items for dispatch
- `store-manager`
  - receive challans
  - POS checkout
  - local adjustments that do not "add" stock (recount/loss)
- `finance-admin`
  - view cost and profit fields
  - exports/reports
- `finance-manager`
  - view cost and profit fields
  - reports

### Why strict permissions matter
Inventory correctness depends more on preventing the wrong action than "fixing it later".

---

## 8) VAT in Bangladesh (Expectations)

Your system stores VAT inputs per order item at order time. Before production, confirm:
- Do your prices **include VAT** or **exclude VAT** by policy?
- Do you need sequential VAT invoice numbering (per shop / per day / global)?
- Which categories have special VAT rates (if any)?

Align finance rules first, then lock the platform config accordingly.

### VAT invoice numbering used here
- **Per store, per BD day** sequence: `INV-{BRANCHCODE}-{YYYYMMDD}-{NNNN}`
- POS issues invoice at checkout; web issues invoice at fulfillment (unless branch chosen at checkout).

---

## 9) Background Tasks

Background processing uses **Arc events + cron intervals** (no job queue):

- **Outbox relay** (every 5 seconds) — delivers pending EventOutbox entries to in-process handlers. Guarantees at-least-once delivery for POS transactions and other critical flows.
- **Reservation cleanup** (every 5 minutes) — expires stale stock reservations from abandoned web checkouts across all bootstrapped organizations.

Both tasks are registered in `src/cron/index.ts` and start automatically with the server.

---

## 10) Go-Live Checklist

- Atlas
  - [ ] PITR/backups enabled
  - [ ] Alerts configured
  - [ ] DB user uses least privilege
  - [ ] Network access restricted (IP allowlist / VPC peering)
- Runtime
  - [ ] Run the API under a supervisor/restart policy (systemd/PM2/Docker/K8s)
  - [ ] Ensure health checks + auto-restart are working (kill the process and verify it returns)
  - [ ] Verify outbox relay and reservation cleanup cron are running (check logs for "Cron jobs and event handlers initialized")
- Platform
  - [ ] Head office branch set
  - [ ] Default branch set
  - [ ] Roles created and assigned correctly
  - [ ] Exports restricted to finance/admin
- Operations
  - [ ] Warehouse SOP: Purchase → Challan → Dispatch
  - [ ] Store SOP: Receive → POS sale → Recount adjustment
  - [ ] Staff trained on "never add stock at store via adjustment"

---

## 11) Transaction Categories (Quick Reference)

Your system records all financial events to proper categories for reporting:

| Category | Type | When Used |
|----------|------|-----------|
| **REVENUE** | | |
| `order_purchase` | Income | POS + Web sales |
| `wholesale_sale` | Income | B2B sales (optional) |
| `tip_income` | Income | Customer tips |
| **INVENTORY** | | |
| `inventory_purchase` | Expense | Stock bought from suppliers |
| `purchase_return` | Income | Credit for returned stock |
| `inventory_loss` | Expense | Damaged/lost items |
| `cogs` | Expense | Cost of goods sold (at fulfillment, optional) |
| **OPERATIONAL** | | |
| `rent` | Expense | Office/store rent |
| `utilities` | Expense | Electric, water, internet |
| `equipment` | Expense | Hardware, fixtures |
| `marketing` | Expense | Ads, promotions |
| `capital_injection` | Income | Owner investment |

**Best Practice:**
- Use `inventory_purchase` with `createTransaction: true` only when you need actual expense tracking.
- For manufacturing/homemade products, use `createTransaction: false` (cost is tracked in profit only).
- Enable `recordCogs: true` during fulfillment for double-entry accounting.

---

## 12) Related Documentation

- **Architecture Overview**: See `docs/architecture.md` for complete system design
- **Transaction Guide**: See `src/resources/transaction/` for transaction models and workflows
- **Inventory Guide**: See `src/resources/inventory/` for stock management
- **POS Guide**: See `src/resources/sales/pos/` for point-of-sale operations
- **Order Guide**: See `src/resources/sales/orders/` for order lifecycle
