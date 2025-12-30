# BD Retail Inventory & Supplier Management - Backend Improvement Roadmap

**Last Updated:** 2025-01-20  
**Target:** Lightweight, intelligent inventory system optimized for Bangladesh retail operations

---

## Executive Summary

This roadmap outlines improvements to transform our inventory and supplier management system into a production-grade, BD-compliant solution. Focus areas: **concurrency safety**, **audit compliance**, **operational efficiency**, and **maintainability**.

**Current State:** ✅ Strong foundation (good separation of concerns, correct BD retail flow)  
**Target State:** 🎯 Industry-standard with atomic operations, smart supplier analytics, and zero data loss

---

## Core Principles (Non-Negotiable)

1. **Single Source of Truth**: `StockEntry(product, variantSku, branch)` is authoritative
2. **Immutable Audit Trail**: Every stock change creates a `StockMovement` record
3. **Head Office Control**: New stock enters only via Purchase → Transfer distribution
4. **No Oversell**: Reservation system protects `quantity - reservedQuantity`
5. **BD Compliance**: Audit records retained (no TTL deletion of business data)

---

## Phase 1: Critical Fixes (Week 1-2)

### 🔴 Priority 1: Concurrency-Safe Numbering

**Problem:** Current "find latest +1" approach will generate duplicate codes under load/multi-instance.

**Impact:** High - Can cause invoice/challan number collisions in production

**Solution:**
- Create atomic counter collection
- Replace all code generation with counter-based approach

**Files to Modify:**
- `modules/commerce/inventory/supplier/supplier.model.js` - `generateCode()`
- `modules/commerce/inventory/purchase/purchase.model.js` - `generateInvoiceNumber()`
- `modules/commerce/inventory/transfer/transfer.model.js` - `generateChallanNumber()`
- `modules/commerce/inventory/stock-request/stock-request.model.js` - `generateRequestNumber()`

**Implementation:**
```javascript
// Create: lib/mongokit/src/utils/counter.ts (or .js)
// Usage in models:
const counter = await Counter.increment('CHN', '202512');
const challanNumber = `CHN-202512-${String(counter).padStart(4, '0')}`;
```

**Acceptance Criteria:**
- [ ] Counter collection created with schema: `{ type, yyyymm, seq }`
- [ ] All 4 numbering functions use atomic `findOneAndUpdate({$inc: {seq:1}})`
- [ ] Integration test: 100 parallel creates → 100 unique numbers
- [ ] Backward compatible (existing codes remain valid)

---

### 🔴 Priority 2: Idempotency for State Transitions

**Problem:** Network retries can cause duplicate dispatch/receive/pay operations.

**Impact:** High - Can double-move stock or double-pay invoices

**Solution:**
- Add `Idempotency-Key` header support to action endpoints
- Store processed keys with TTL (24h)

**Files to Modify:**
- `core/factories/createActionRouter.js` - Add idempotency middleware
- `modules/commerce/inventory/transfer/transfer.service.js` - Check idempotency key
- `modules/commerce/inventory/purchase/purchase-invoice.service.js` - Check idempotency key

**Implementation:**
```javascript
// Create: common/utils/idempotency.js
// In createActionRouter: check header before executing action
const idempotencyKey = req.headers['idempotency-key'];
if (idempotencyKey) {
  const cached = await IdempotencyCache.get(idempotencyKey);
  if (cached) return cached.result;
}
// ... execute action ...
await IdempotencyCache.set(idempotencyKey, result, 86400);
```

**Acceptance Criteria:**
- [ ] Action endpoints accept `Idempotency-Key` header
- [ ] Duplicate requests with same key return cached result (no side effects)
- [ ] Keys expire after 24h
- [ ] Integration test: duplicate dispatch with same key → only one stock movement

---

### 🟡 Priority 3: Remove Dead Code / Reduce Drift

**Problem:** `InventoryService.transferStock()` exists but is unused (drift risk).

**Impact:** Medium - Confuses future developers, potential for bugs

**Solution:**
- Remove or mark as deprecated/private

**Files to Modify:**
- `modules/commerce/inventory/inventory.service.js` - Remove `transferStock()` method (lines ~880-961)

**Acceptance Criteria:**
- [ ] Method removed or clearly marked `@deprecated` with migration note
- [ ] No references found in codebase (grep confirms)
- [ ] Tests still pass

---

## Phase 2: Atomicity & Consistency (Week 3-4)

### 🔴 Priority 4: Atomic State Transitions

**Problem:** Stock updates and document status updates happen separately. Process crash = inconsistent state.

**Impact:** High - Can have stock moved but transfer still "approved", or purchase stock added but status still "draft"

**Solution:**
- Use MongoDB sessions for multi-document transactions
- Wrap stock update + status update in single transaction

**Files to Modify:**
- `modules/commerce/inventory/transfer/transfer.service.js` - `dispatchTransfer()`, `receiveTransfer()`
- `modules/commerce/inventory/purchase/purchase-invoice.service.js` - `receivePurchase()`, `payPurchase()`
- `modules/commerce/inventory/inventory.service.js` - Accept optional `session` parameter

**Implementation:**
```javascript
// In transfer.service.js dispatchTransfer():
const session = await mongoose.startSession();
session.startTransaction();
try {
  const decrementResult = await inventoryService.decrementBatch(
    stockItems, branch, reference, actorId, session // Pass session
  );
  transfer.status = TransferStatus.DISPATCHED;
  await transfer.save({ session });
  await session.commitTransaction();
} catch (error) {
  await session.abortTransaction();
  throw error;
} finally {
  session.endSession();
}
```

**Acceptance Criteria:**
- [ ] All state transitions use sessions (dispatch, receive, purchase receive, pay)
- [ ] Integration test: simulate crash mid-transaction → verify rollback
- [ ] Graceful fallback if replica set not available (log warning, continue non-transactional)

---

### 🟡 Priority 5: Batch Product Lookups

**Problem:** `PurchaseInvoiceService._normalizeItems()` loads products one-by-one (N+1 query).

**Impact:** Medium - Slow for large purchase orders

**Solution:**
- Batch query all products upfront (like `transfer.service.js` already does)

**Files to Modify:**
- `modules/commerce/inventory/purchase/purchase-invoice.service.js` - `_normalizeItems()`

**Acceptance Criteria:**
- [ ] Single `Product.find({_id: {$in: productIds}})` query
- [ ] Performance test: 50 items → <100ms (vs current ~500ms+)
- [ ] Error handling: missing products reported clearly

---

## Phase 3: Repository Consistency (Week 5)

### 🟡 Priority 6: MongoKit Repositories for Transfer & StockRequest

**Problem:** Transfer and StockRequest use raw Mongoose queries, inconsistent with Supplier/Purchase patterns.

**Impact:** Medium - Harder to maintain, inconsistent query parsing/pagination

**Solution:**
- Create `transfer.repository.js` and `stock-request.repository.js` using MongoKit
- Migrate controllers to use repositories

**Files to Create:**
- `modules/commerce/inventory/transfer/transfer.repository.js`
- `modules/commerce/inventory/stock-request/stock-request.repository.js`

**Files to Modify:**
- `modules/commerce/inventory/transfer/transfer.service.js` - Use repository for queries
- `modules/commerce/inventory/stock-request/stock-request.service.js` - Use repository for queries
- `modules/commerce/inventory/transfer/transfer.controller.js` - Use repository via BaseController
- `modules/commerce/inventory/stock-request/stock-request.controller.js` - Use repository via BaseController

**Implementation Pattern:**
```javascript
// transfer.repository.js
import { Repository, validationChainPlugin } from '@classytic/mongokit';
import Transfer from './transfer.model.js';

class TransferRepository extends Repository {
  constructor() {
    super(Transfer, [
      validationChainPlugin([
        requireField('senderBranch', ['create']),
        requireField('receiverBranch', ['create']),
      ]),
    ]);
  }

  async appendStatus(id, statusEntry, updates = {}) {
    return this.Model.findByIdAndUpdate(
      id,
      { ...updates, $push: { statusHistory: statusEntry } },
      { new: true }
    ).lean();
  }
}

export default new TransferRepository();
```

**Acceptance Criteria:**
- [ ] Both repositories extend MongoKit `Repository`
- [ ] Controllers use `BaseController` pattern (consistent with Supplier)
- [ ] Query parsing works: `?status=dispatched&senderBranch=xxx&page=1&limit=20`
- [ ] All existing tests pass

---

## Phase 4: Smart BD Retail Features (Week 6-8)

### 🟢 Priority 7: Supplier Analytics (No DB Schema Changes)

**Problem:** No visibility into supplier payment behavior, outstanding dues, or aging.

**Impact:** Low-Medium - Business value (finance team needs this)

**Solution:**
- Add computed fields/endpoints using existing Purchase data

**Files to Create:**
- `modules/commerce/inventory/supplier/supplier.analytics.js`

**Files to Modify:**
- `modules/commerce/inventory/supplier/supplier.controller.js` - Add analytics endpoint

**Implementation:**
```javascript
// supplier.analytics.js
async getSupplierAnalytics(supplierId) {
  const purchases = await Purchase.find({ supplier: supplierId }).lean();
  
  const outstanding = purchases
    .filter(p => p.paymentStatus !== 'paid')
    .reduce((sum, p) => sum + (p.dueAmount || 0), 0);
  
  const aging = this._computeAgingBuckets(purchases);
  const avgDaysToPay = this._computeAvgPaymentDays(purchases);
  
  return { outstanding, aging, avgDaysToPay, totalPurchases: purchases.length };
}
```

**Acceptance Criteria:**
- [ ] Endpoint: `GET /api/v1/inventory/suppliers/:id/analytics`
- [ ] Returns: outstanding, aging buckets (0-7, 8-15, 16-30, 30+ days), avg payment days
- [ ] Performance: <200ms for supplier with 1000 purchases (use aggregation pipeline)

---

### 🟢 Priority 8: Supplier Name Uniqueness (Case-Insensitive)

**Problem:** Can create "ABC Supplier" and "abc supplier" (duplicates).

**Impact:** Low - Data quality issue

**Solution:**
- Add `nameNormalized` field with unique index
- Normalize on create/update

**Files to Modify:**
- `modules/commerce/inventory/supplier/supplier.model.js` - Add field + index
- `modules/commerce/inventory/supplier/supplier.repository.js` - Normalize in `before:create` hook

**Acceptance Criteria:**
- [ ] Unique index on `nameNormalized` (partial: `isActive: true`)
- [ ] Create "ABC" then "abc" → second fails with clear error
- [ ] Migration script for existing suppliers

---

### 🟢 Priority 9: Low Stock Query Optimization

**Problem:** `$expr` query in `getLowStock()` is hard to index efficiently.

**Impact:** Low - Only affects dashboard performance (acceptable for now, but worth fixing)

**Solution:**
- Add derived field `needsReorder: boolean` updated on stock writes
- Use simple indexed query: `{ branch, needsReorder: true }`

**Files to Modify:**
- `modules/commerce/inventory/stockEntry.model.js` - Add `needsReorder` field + index
- `modules/commerce/inventory/inventory.service.js` - Update `needsReorder` in `setStock()`, `decrementBatch()`, `restoreBatch()`
- `modules/commerce/inventory/inventory.repository.js` - Use indexed query in `getLowStock()`

**Acceptance Criteria:**
- [ ] `needsReorder` computed on write (not read)
- [ ] Low stock query <50ms for branch with 10k products
- [ ] Migration: backfill `needsReorder` for existing entries

---

## Phase 5: Data Retention & Compliance (Week 9)

### 🟡 Priority 10: Archive Instead of TTL Delete

**Problem:** TTL indexes auto-delete `StockMovement` and `Transfer` after 2 years (BD compliance risk).

**Impact:** Medium - Legal/compliance issue

**Solution:**
- Remove TTL indexes
- Use archive module for old data (export to S3/file, then delete)
- Make retention configurable via env

**Files to Modify:**
- `modules/commerce/inventory/stockMovement.model.js` - Remove TTL index
- `modules/commerce/inventory/transfer/transfer.model.js` - Remove TTL index
- `modules/commerce/inventory/inventory.repository.js` - Add `archiveOldMovements()` method (already exists, enhance it)

**Configuration:**
```env
# .env
INVENTORY_ARCHIVE_AFTER_DAYS=730  # 2 years
INVENTORY_ARCHIVE_TTL_DAYS=1825    # 5 years in archive before delete
```

**Acceptance Criteria:**
- [ ] TTL indexes removed
- [ ] Archive job runs weekly (cron)
- [ ] Old movements exported to archive storage before deletion
- [ ] Configurable via env (defaults to 2 years)

---

## Testing Requirements

### Unit Tests
- [ ] Counter generation: concurrent creates → unique numbers
- [ ] Idempotency: duplicate action requests → cached result
- [ ] Atomic transactions: crash simulation → rollback verified

### Integration Tests
- [ ] Purchase receive → stock increased + movement created + status updated (atomic)
- [ ] Transfer dispatch → stock decremented + movement created + status updated (atomic)
- [ ] Transfer receive (multi-step partial) → correct deltas, no double-add
- [ ] Reservation commit → stock decremented, reservation released
- [ ] Supplier analytics → correct outstanding/aging calculations

### Performance Tests
- [ ] Batch product lookup: 50 items <100ms
- [ ] Low stock query: 10k products <50ms
- [ ] Supplier analytics: 1000 purchases <200ms

---

## Success Metrics

### Phase 1-2 (Critical Fixes)
- ✅ Zero duplicate invoice/challan numbers in production
- ✅ Zero duplicate stock movements from retries
- ✅ All state transitions atomic (no inconsistent states)

### Phase 3 (Consistency)
- ✅ 100% of inventory modules use MongoKit repositories
- ✅ Consistent query parsing across all endpoints

### Phase 4 (Smart Features)
- ✅ Finance team can view supplier outstanding/aging
- ✅ Low stock dashboard loads <1s for 10k products

### Phase 5 (Compliance)
- ✅ Audit records retained per BD requirements
- ✅ Archive process runs automatically

---

## Implementation Notes

### Code Style
- Follow existing patterns (MongoKit repositories, BaseController, action routers)
- Use async/await (no callbacks)
- Structured logging with context (`logger.info({ transferId, branchId }, 'message')`)

### Error Handling
- Use `createStatusError()` pattern (already in codebase)
- Return clear error messages for business rule violations
- Log errors with full context for debugging

### Migration Strategy
- All changes backward compatible (existing data remains valid)
- Use feature flags if needed for gradual rollout
- Test in staging with production-like data volume

---

## Quick Reference: File Touchpoints

### High Priority (Phase 1-2)
- `modules/commerce/inventory/supplier/supplier.model.js`
- `modules/commerce/inventory/purchase/purchase.model.js`
- `modules/commerce/inventory/transfer/transfer.model.js`
- `modules/commerce/inventory/transfer/transfer.service.js`
- `modules/commerce/inventory/purchase/purchase-invoice.service.js`
- `modules/commerce/inventory/inventory.service.js`
- `core/factories/createActionRouter.js`

### Medium Priority (Phase 3-5)
- `modules/commerce/inventory/transfer/transfer.repository.js` (new)
- `modules/commerce/inventory/stock-request/stock-request.repository.js` (new)
- `modules/commerce/inventory/supplier/supplier.analytics.js` (new)
- `modules/commerce/inventory/stockEntry.model.js`
- `modules/commerce/inventory/stockMovement.model.js`

---

## Questions / Blockers?

If you encounter issues:
1. Check existing tests for patterns
2. Review `docs/api/commerce/inventory.md` for business rules
3. Consult playbook principles (atomicity, audit trail, head office control)

**Estimated Total Effort:** 6-8 weeks (1 engineer, full-time)

---

*This roadmap is a living document. Update as priorities change or new requirements emerge.*

