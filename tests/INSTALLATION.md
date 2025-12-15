# Test Suite Installation & Quick Start

## Prerequisites

- Node.js >= 18
- npm or yarn
- Project already has `"type": "module"` in package.json ✓

## 1. Install Test Dependencies

Run this command to install Vitest and MongoDB Memory Server as dev dependencies:

```bash
npm install --save-dev vitest @vitest/ui mongodb-memory-server
```

**What gets installed:**
- `vitest` - Fast test runner with native ES modules support
- `@vitest/ui` - Interactive UI for running and debugging tests
- `mongodb-memory-server` - In-memory MongoDB for testing

## 2. Verify Installation

Check that scripts were added to `package.json`:

```bash
npm run test -- --version
```

Should output: `vitest/x.x.x`

## 3. Run Tests

### Option A: Run All Tests (Headless)
```bash
npm test
```

### Option B: Run with Interactive UI (Recommended for Development)
```bash
npm run test:ui
```

Opens browser at `http://localhost:51204/__vitest__/` with:
- Visual test tree
- Real-time results
- Code coverage
- Console output
- Rerun on file changes

### Option C: Run Specific Test File
```bash
npx vitest tests/integration/inventory-service.test.js
```

### Option D: Run with Coverage Report
```bash
npm run test:coverage
```

Generates coverage report in `coverage/` directory.

## 4. Expected Output

### Successful Test Run:

```
✓ tests/integration/inventory-service.test.js (18 tests) 2543ms
  ✓ Inventory Service - Event Emissions & Cache
    ✓ decrementBatch - Event Emissions
      ✓ should emit after:update events for each decremented item
      ✓ should invalidate barcode cache after decrement
      ✓ should emit low-stock event when quantity drops below reorderPoint
      ✓ should emit out-of-stock event when quantity reaches 0
    ✓ restoreBatch - Event Emissions
      ✓ should emit after:update events for each restored item
      ✓ should invalidate barcode cache after restore
    ✓ Product Sync with Retry Logic
      ✓ should retry product sync on failure
      ✓ should log critical error after all retries fail
      ✓ should successfully sync product quantity on first try
    ✓ Variant Products - Quantity Sync
      ✓ should sync variant product quantity correctly

✓ tests/integration/logistics-webhook.test.js (15 tests) 1823ms
  ✓ Logistics Webhook - Order Status Propagation
    ✓ Webhook Processing
      ✓ should update shipment status from webhook
      ✓ should propagate shipment status to order shipping
      ✓ should advance order status when shipment is picked up
      ✓ should advance order status to delivered when shipment delivered
      ✓ should update order shipping metadata with provider info
      ✓ should add shipping history entry on webhook
      ✓ should not update order for on-hold shipment status
      ✓ should handle multiple webhooks correctly
    ✓ trackShipment - Status Propagation
      ✓ should propagate status to order when tracking
      ✓ should not propagate if status unchanged
    ✓ Status Mapping
      ✓ should map shipment statuses correctly (6 tests)
    ✓ Error Handling
      ✓ should not fail webhook processing if order update fails
      ✓ should warn if shipment has no linked order

✓ tests/integration/redx-validation.test.js (20 tests) 1245ms
  ✓ RedX Provider - Payload Validation
    ✓ Required Field Validation
      ✓ should reject order without customer name
      ✓ should reject order without customer phone
      ✓ should reject order without delivery address
      ✓ should reject order without delivery area name
      ✓ should reject order without delivery area ID
      ✓ should reject order without pickup store ID
      ✓ should reject order without merchant invoice ID
    ✓ Multiple Missing Fields
      ✓ should list all missing fields in error message
      ✓ should include order details in error message
    ✓ Valid Order Processing
      ✓ should accept order with all required fields
      ✓ should use default pickup store from config if not provided
      ✓ should accept order with deliveryAddress.name fallback
    ✓ Field Trimming
      ✓ should reject fields with only whitespace
      ✓ should accept trimmed valid fields
    ✓ Integration with Full Order Model
      ✓ should validate real order with missing area data
      ✓ should accept real order with complete area data

Test Files  3 passed (3)
     Tests  53 passed (53)
  Start at  10:00:00
  Duration  5.62s

 PASS  Waiting for file changes...
```

## 5. Troubleshooting

### MongoDB Memory Server Download Issues

If you see "MongoDB binary download failed":

```bash
# Option 1: Use mirror
export MONGOMS_DOWNLOAD_MIRROR=https://fastdl.mongodb.org
npm test

# Option 2: Clear cache and retry
rm -rf ~/.cache/mongodb-binaries
npm test

# Option 3: Pre-download binary (Windows)
npx mongodb-memory-server-download --version 7.0.0
```

### Port Already in Use (Test UI)

If test UI port is taken:

```bash
# Use different port
npx vitest --ui --port 3456
```

### Import/Module Errors

Verify Node.js version:

```bash
node --version  # Should be >= 18
```

### Tests Hang or Timeout

Increase timeout in `tests/setup/vitest.config.js`:

```javascript
export default defineConfig({
  test: {
    testTimeout: 60000,  // 60 seconds
  },
});
```

## 6. Quick Test Verification

Run this single command to verify everything works:

```bash
npm test -- --reporter=verbose --run
```

Should complete in ~10 seconds with all tests passing.

## 7. Next Steps

- Read `tests/README.md` for detailed test documentation
- Run `npm run test:ui` to explore tests interactively
- Add tests for your own features in `tests/integration/`

## 8. CI/CD Integration

Add to your GitHub Actions workflow:

```yaml
name: Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm ci
      - run: npm test
      - run: npm run test:coverage
```

## Need Help?

- **Vitest Docs**: https://vitest.dev/
- **MongoDB Memory Server**: https://github.com/nodkz/mongodb-memory-server
- **Test Files**: Check `tests/integration/*.test.js` for examples

---

**Ready to run tests?**

```bash
npm install --save-dev vitest @vitest/ui mongodb-memory-server
npm test
```

✅ **That's it!** Tests will run automatically with MongoDB in memory.
