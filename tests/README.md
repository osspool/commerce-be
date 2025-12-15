# Integration Tests

Comprehensive integration test suite for the BigBoss E-commerce Backend.

## Setup

### 1. Install Dependencies

```bash
npm install --save-dev vitest @vitest/ui mongodb-memory-server supertest
```

### 2. Update package.json

Add the following scripts to `package.json`:

```json
{
  "scripts": {
    "test": "vitest --config tests/setup/vitest.config.js",
    "test:ui": "vitest --config tests/setup/vitest.config.js --ui",
    "test:coverage": "vitest --config tests/setup/vitest.config.js --coverage",
    "test:watch": "vitest --config tests/setup/vitest.config.js --watch"
  }
}
```

## Running Tests

### Run All Tests
```bash
npm test
```

### Run Tests with UI (Interactive)
```bash
npm run test:ui
```

### Run Tests with Coverage
```bash
npm run test:coverage
```

### Run Tests in Watch Mode
```bash
npm run test:watch
```

### Run Specific Test File
```bash
npx vitest tests/integration/inventory-service.test.js
```

## Test Structure

```
tests/
├── setup/
│   ├── vitest.config.js    # Vitest configuration
│   └── setup.js            # Global test setup (MongoDB Memory Server)
├── helpers/
│   ├── test-data.js        # Test data factories
│   └── test-utils.js       # Test utilities
└── integration/
    ├── inventory-service.test.js    # Inventory service tests
    ├── logistics-webhook.test.js    # Logistics webhook tests
    └── redx-validation.test.js      # RedX validation tests
```

## Test Coverage

### 1. Inventory Service Tests (`inventory-service.test.js`)

Tests for **Fix #1 & #2**: Repository event emissions and product sync retry logic

**Test Cases:**
- ✅ Events emitted after `decrementBatch`
- ✅ Events emitted after `restoreBatch`
- ✅ Barcode cache invalidated after operations
- ✅ Low-stock alerts fire when `quantity <= reorderPoint`
- ✅ Out-of-stock events fire when `quantity === 0`
- ✅ Product sync retries on failure (3 attempts with exponential backoff)
- ✅ Critical error logged after all retries fail
- ✅ Variant product quantity synced correctly

### 2. Logistics Webhook Tests (`logistics-webhook.test.js`)

Tests for **Fix #3**: Webhook propagation to order shipping/status

**Test Cases:**
- ✅ Shipment status updated from webhook
- ✅ Order shipping status updated from shipment webhook
- ✅ Order status advances correctly (picked_up → shipped, delivered → delivered)
- ✅ Shipping metadata includes provider info and timestamp
- ✅ Shipping history entries added on webhook
- ✅ No update for on-hold status
- ✅ Multiple webhooks handled correctly
- ✅ `trackShipment` propagates status changes
- ✅ Status mapping works for all shipment statuses
- ✅ Error handling: webhook succeeds even if order update fails

### 3. RedX Validation Tests (`redx-validation.test.js`)

Tests for **Fix #4**: Payload validation before API call

**Test Cases:**
- ✅ Rejects orders missing `customer_name`
- ✅ Rejects orders missing `customer_phone`
- ✅ Rejects orders missing `customer_address`
- ✅ Rejects orders missing `delivery_area` (name)
- ✅ Rejects orders missing `delivery_area_id`
- ✅ Rejects orders missing `pickup_store_id`
- ✅ Rejects orders missing `merchant_invoice_id`
- ✅ Lists all missing fields in error message
- ✅ Includes order context in error (ID, customer, phone, area)
- ✅ Accepts orders with all required fields
- ✅ Uses default pickup store from config
- ✅ Accepts fallback fields (deliveryAddress.name)
- ✅ Trims whitespace correctly
- ✅ Validates real Order model instances

## Writing New Tests

### Test Data Factories

Use factories from `helpers/test-data.js`:

```javascript
import {
  createTestProduct,
  createTestBranch,
  createTestStockEntry,
  createTestOrder,
  createTestShipment,
  createTestCustomer,
  createRedXWebhookPayload,
} from '../helpers/test-data.js';

// Create test product
const product = await Product.create(createTestProduct());

// Create test order
const order = await Order.create(createTestOrder(customerId));

// Create webhook payload
const webhook = createRedXWebhookPayload('TRK-123', 'delivered');
```

### Test Utilities

Use utilities from `helpers/test-utils.js`:

```javascript
import {
  waitFor,
  createEventSpy,
  mockRedXApi,
  captureConsole,
  sleep,
} from '../helpers/test-utils.js';

// Wait for event
const eventPromise = createEventSpy(emitter, 'event-name');
const eventData = await eventPromise;

// Mock external API
const redxMock = mockRedXApi();
// ... test code ...
redxMock.restore();

// Capture console logs
const console = captureConsole();
// ... test code ...
expect(console.logs.error).toContain('CRITICAL');
console.restore();
```

### Database Cleanup

All collections are automatically cleared before each test in `setup.js`.

## Environment

Tests run against **MongoDB Memory Server** - a real MongoDB instance running in memory.
- Fast (no disk I/O)
- Isolated (doesn't affect production or dev databases)
- Automatic cleanup

## Debugging Tests

### Enable Verbose Logging
```bash
DEBUG=* npm test
```

### Run Single Test
```javascript
it.only('should test specific case', async () => {
  // ...
});
```

### Skip Test
```javascript
it.skip('should skip this test', async () => {
  // ...
});
```

### Use Vitest UI
```bash
npm run test:ui
```
Opens a browser UI with:
- Test file tree
- Console output
- Code coverage
- Watch mode

## Continuous Integration

Add to your CI pipeline (GitHub Actions, GitLab CI, etc.):

```yaml
- name: Run Tests
  run: npm test

- name: Generate Coverage
  run: npm run test:coverage

- name: Upload Coverage
  uses: codecov/codecov-action@v3
  with:
    files: ./coverage/lcov.info
```

## Troubleshooting

### MongoDB Memory Server Won't Start

```bash
# Clear MongoDB binary cache
rm -rf ~/.cache/mongodb-binaries

# Or set download mirror
export MONGOMS_DOWNLOAD_MIRROR=https://fastdl.mongodb.org
```

### Tests Timeout

Increase timeout in `vitest.config.js`:

```javascript
export default defineConfig({
  test: {
    testTimeout: 60000,  // 60 seconds
    hookTimeout: 60000,
  },
});
```

### Import Errors

Make sure Node.js version is >=18 and `"type": "module"` is in package.json.

## Best Practices

1. **Test Isolation**: Each test should be independent and not rely on other tests
2. **Cleanup**: Always restore mocks and spies after tests
3. **Descriptive Names**: Test names should describe what they're testing
4. **Arrange-Act-Assert**: Follow AAA pattern in tests
5. **Fast Tests**: Keep tests fast by using in-memory database and minimal setup

## Coverage Goals

- **Lines**: > 80%
- **Branches**: > 75%
- **Functions**: > 80%
- **Statements**: > 80%

Run `npm run test:coverage` to see current coverage.
