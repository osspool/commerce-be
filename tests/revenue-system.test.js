import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Revenue } from '@classytic/revenue';
import { ManualProvider } from '@classytic/revenue-manual';

/**
 * Revenue System Tests
 *
 * Tests the revenue builder configuration, service APIs, event system,
 * and payment lifecycle. Uses in-memory models (no MongoDB required).
 */

// Minimal mock model for testing (mimics Mongoose API surface)
function createMockModel() {
  const store = new Map();
  let counter = 0;

  function MockModel(doc) {
    const id = doc._id || `mock_${++counter}`;
    const instance = {
      ...doc,
      _id: id,
      toObject() { return { ...this }; },
      save: vi.fn().mockImplementation(async function () {
        store.set(id, { ...this });
        return this;
      }),
    };
    store.set(id, instance);
    return instance;
  }

  MockModel.create = vi.fn().mockImplementation(async (doc) => {
    const instance = MockModel(doc);
    return instance;
  });
  MockModel.findById = vi.fn().mockImplementation((id) => {
    const found = store.get(id?.toString?.() ?? id);
    return {
      select: () => ({ lean: () => Promise.resolve(found ? { ...found } : null) }),
      then: (cb) => Promise.resolve(found ?? null).then(cb),
    };
  });
  MockModel.findOne = vi.fn().mockImplementation((query) => {
    // Support findOne({ _id }) and findOne({ paymentIntentId })
    for (const [, doc] of store) {
      let match = true;
      for (const [key, val] of Object.entries(query || {})) {
        if (doc[key]?.toString?.() !== val?.toString?.()) { match = false; break; }
      }
      if (match) return Promise.resolve(doc);
    }
    return Promise.resolve(null);
  });
  MockModel.findByIdAndUpdate = vi.fn().mockImplementation(async (id, update) => {
    const existing = store.get(id?.toString?.() ?? id);
    if (!existing) return null;
    const $set = update.$set || update;
    const updated = { ...existing, ...$set };
    store.set(id?.toString?.() ?? id, updated);
    return updated;
  });
  MockModel.find = vi.fn().mockReturnValue({
    select: () => ({ lean: () => Promise.resolve([]) }),
    lean: () => Promise.resolve([]),
  });
  MockModel.countDocuments = vi.fn().mockResolvedValue(0);
  MockModel._store = store;
  MockModel._clear = () => store.clear();

  return MockModel;
}

// ============ TESTS ============

describe('Revenue Builder Configuration', () => {
  it('builds with all recommended features', () => {
    const Transaction = createMockModel();

    const revenue = Revenue
      .create({ defaultCurrency: 'BDT' })
      .withModels({ Transaction })
      .withProvider('manual', new ManualProvider())
      .forEnvironment('development')
      .withDebug(true)
      .withRetry({ maxAttempts: 3, baseDelay: 1000 })
      .withCircuitBreaker(false)
      .withCategoryMappings({ Order: 'order_purchase' })
      .withTransactionTypeMapping({
        order_purchase: 'inflow',
        refund: 'outflow',
      })
      .build();

    expect(revenue).toBeDefined();
    expect(revenue.defaultCurrency).toBe('BDT');
    expect(revenue.environment).toBe('development');
    expect(revenue.hasProvider('manual')).toBe(true);
    expect(revenue.getProviderNames()).toEqual(['manual']);
  });

  it('throws without models', () => {
    expect(() => {
      Revenue.create().withProvider('manual', new ManualProvider()).build();
    }).toThrow(/Models are required/);
  });

  it('throws without providers', () => {
    const Transaction = createMockModel();
    expect(() => {
      Revenue.create().withModels({ Transaction }).build();
    }).toThrow(/At least one provider is required/);
  });

  it('throws when accessing nonexistent provider', () => {
    const Transaction = createMockModel();
    const revenue = Revenue
      .create()
      .withModels({ Transaction })
      .withProvider('manual', new ManualProvider())
      .build();

    expect(() => revenue.getProvider('stripe')).toThrow(/Provider "stripe" not found/);
  });

  it('freezes providers and config after build', () => {
    const Transaction = createMockModel();
    const revenue = Revenue
      .create({ defaultCurrency: 'BDT' })
      .withModels({ Transaction })
      .withProvider('manual', new ManualProvider())
      .build();

    expect(Object.isFrozen(revenue.providers)).toBe(true);
    expect(Object.isFrozen(revenue.config)).toBe(true);
  });
});

describe('Revenue Event System (dot-notation)', () => {
  let revenue;
  let Transaction;

  beforeEach(() => {
    Transaction = createMockModel();
    revenue = Revenue
      .create({ defaultCurrency: 'BDT' })
      .withModels({ Transaction })
      .withProvider('manual', new ManualProvider())
      .build();
  });

  afterEach(async () => {
    await revenue.destroy();
    Transaction._clear();
  });

  it('emits and receives payment.verified event', async () => {
    const handler = vi.fn();
    revenue.on('payment.verified', handler);

    revenue.emit('payment.verified', {
      transaction: { _id: 'txn_1', amount: 5000 },
      paymentResult: { status: 'succeeded' },
      verifiedBy: 'admin_1',
    });

    // Events are fire-and-forget, give microtask time to settle
    await new Promise(r => setTimeout(r, 50));
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({
      type: 'payment.verified',
      verifiedBy: 'admin_1',
    });
  });

  it('emits payment.failed event', async () => {
    const handler = vi.fn();
    revenue.on('payment.failed', handler);

    revenue.emit('payment.failed', {
      transaction: { _id: 'txn_2' },
      error: 'Insufficient funds',
      provider: 'manual',
      paymentIntentId: 'pi_1',
    });

    await new Promise(r => setTimeout(r, 50));
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].error).toBe('Insufficient funds');
  });

  it('emits payment.refunded event', async () => {
    const handler = vi.fn();
    revenue.on('payment.refunded', handler);

    revenue.emit('payment.refunded', {
      transaction: { _id: 'txn_3', amount: 5000 },
      refundTransaction: { _id: 'txn_4', amount: 2500 },
      refundResult: { status: 'succeeded' },
      refundAmount: 2500,
      isPartialRefund: true,
    });

    await new Promise(r => setTimeout(r, 50));
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].refundAmount).toBe(2500);
    expect(handler.mock.calls[0][0].isPartialRefund).toBe(true);
  });

  it('emits monetization.created event', async () => {
    const handler = vi.fn();
    revenue.on('monetization.created', handler);

    revenue.emit('monetization.created', {
      monetizationType: 'purchase',
      transaction: { _id: 'txn_5', sourceModel: 'Order', amount: 3000 },
    });

    await new Promise(r => setTimeout(r, 50));
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].monetizationType).toBe('purchase');
  });

  it('once() fires only once', async () => {
    const handler = vi.fn();
    revenue.once('payment.verified', handler);

    revenue.emit('payment.verified', {
      transaction: { _id: 'txn_a' },
      paymentResult: {},
    });
    revenue.emit('payment.verified', {
      transaction: { _id: 'txn_b' },
      paymentResult: {},
    });

    await new Promise(r => setTimeout(r, 50));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('off() removes handler', async () => {
    const handler = vi.fn();
    revenue.on('payment.verified', handler);
    revenue.off('payment.verified', handler);

    revenue.emit('payment.verified', {
      transaction: { _id: 'txn_c' },
      paymentResult: {},
    });

    await new Promise(r => setTimeout(r, 50));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('Revenue Services API', () => {
  let revenue;
  let Transaction;

  beforeEach(() => {
    Transaction = createMockModel();
    revenue = Revenue
      .create({ defaultCurrency: 'BDT' })
      .withModels({ Transaction })
      .withProvider('manual', new ManualProvider())
      .withCategoryMappings({ Order: 'order_purchase' })
      .withTransactionTypeMapping({
        order_purchase: 'inflow',
        refund: 'outflow',
      })
      .build();
  });

  afterEach(async () => {
    await revenue.destroy();
    Transaction._clear();
  });

  it('exposes all five services', () => {
    expect(revenue.monetization).toBeDefined();
    expect(revenue.payments).toBeDefined();
    expect(revenue.transactions).toBeDefined();
    expect(revenue.escrow).toBeDefined();
    expect(revenue.settlement).toBeDefined();
  });

  it('monetization.create() creates a transaction', async () => {
    const result = await revenue.monetization.create({
      data: {
        customerId: 'cust_1',
        sourceId: 'order_1',
        sourceModel: 'Order',
      },
      planKey: 'one_time',
      monetizationType: 'purchase',
      amount: 100000,
      currency: 'BDT',
      gateway: 'manual',
      paymentData: { method: 'bkash', trxId: 'BGH3K5L90P' },
      metadata: { orderId: 'order_1', source: 'web' },
    });

    expect(result.transaction).toBeDefined();
    expect(result.transaction._id).toBeDefined();
    expect(result.transaction.amount).toBe(100000);
    expect(result.transaction.status).toBe('pending');
    expect(result.transaction.sourceModel).toBe('Order');
  });

  it('payments.verify() verifies a pending transaction', async () => {
    // Create transaction first
    const { transaction } = await revenue.monetization.create({
      data: { customerId: 'cust_2', sourceId: 'order_2', sourceModel: 'Order' },
      planKey: 'one_time',
      monetizationType: 'purchase',
      amount: 50000,
      currency: 'BDT',
      gateway: 'manual',
      paymentData: { method: 'cash' },
    });

    const result = await revenue.payments.verify(transaction._id, {
      verifiedBy: 'admin_1',
    });

    expect(result.transaction.status).toBe('verified');
    expect(result.transaction.verifiedBy).toBe('admin_1');
    expect(result.transaction.verifiedAt).toBeDefined();
  });

  it('payments.get() returns a transaction (replaces getTransaction)', async () => {
    const { transaction } = await revenue.monetization.create({
      data: { customerId: 'cust_3', sourceId: 'order_3', sourceModel: 'Order' },
      planKey: 'one_time',
      monetizationType: 'purchase',
      amount: 75000,
      currency: 'BDT',
      gateway: 'manual',
      paymentData: { method: 'nagad' },
    });

    const fetched = await revenue.payments.get(transaction._id);

    expect(fetched).toBeDefined();
    expect(fetched._id).toBe(transaction._id);
    expect(fetched.amount).toBe(75000);
  });

  it('payments.get() throws TransactionNotFoundError for missing ID', async () => {
    await expect(
      revenue.payments.get('nonexistent_id')
    ).rejects.toThrow(/not found/i);
  });

  it('payments.verify() throws for already verified transaction', async () => {
    const { transaction } = await revenue.monetization.create({
      data: { customerId: 'cust_4', sourceId: 'order_4', sourceModel: 'Order' },
      planKey: 'one_time',
      monetizationType: 'purchase',
      amount: 30000,
      currency: 'BDT',
      gateway: 'manual',
      paymentData: { method: 'cash' },
    });

    await revenue.payments.verify(transaction._id, { verifiedBy: 'admin_1' });

    await expect(
      revenue.payments.verify(transaction._id, { verifiedBy: 'admin_1' })
    ).rejects.toThrow();
  });

  it('payments.refund() creates a refund transaction', async () => {
    const { transaction } = await revenue.monetization.create({
      data: { customerId: 'cust_5', sourceId: 'order_5', sourceModel: 'Order' },
      planKey: 'one_time',
      monetizationType: 'purchase',
      amount: 100000,
      currency: 'BDT',
      gateway: 'manual',
      paymentData: { method: 'bkash' },
    });

    await revenue.payments.verify(transaction._id, { verifiedBy: 'admin_1' });

    const refundResult = await revenue.payments.refund(
      transaction._id,
      50000,
      { reason: 'Customer requested partial refund' }
    );

    expect(refundResult.refundTransaction).toBeDefined();
    expect(refundResult.refundTransaction.amount).toBe(50000);
    expect(refundResult.transaction.status).toBe('partially_refunded');
  });

  it('full refund sets status to refunded', async () => {
    const { transaction } = await revenue.monetization.create({
      data: { customerId: 'cust_6', sourceId: 'order_6', sourceModel: 'Order' },
      planKey: 'one_time',
      monetizationType: 'purchase',
      amount: 60000,
      currency: 'BDT',
      gateway: 'manual',
      paymentData: { method: 'cash' },
    });

    await revenue.payments.verify(transaction._id, { verifiedBy: 'admin_1' });

    const refundResult = await revenue.payments.refund(
      transaction._id,
      null,
      { reason: 'Full refund' }
    );

    expect(refundResult.refundTransaction.amount).toBe(60000);
    expect(refundResult.transaction.status).toBe('refunded');
  });
});

describe('Revenue Lifecycle Events', () => {
  let revenue;
  let Transaction;

  beforeEach(() => {
    Transaction = createMockModel();
    revenue = Revenue
      .create({ defaultCurrency: 'BDT' })
      .withModels({ Transaction })
      .withProvider('manual', new ManualProvider())
      .build();
  });

  afterEach(async () => {
    await revenue.destroy();
    Transaction._clear();
  });

  it('monetization.create emits monetization.created event', async () => {
    const handler = vi.fn();
    revenue.on('monetization.created', handler);

    await revenue.monetization.create({
      data: { customerId: 'cust_e1', sourceId: 'order_e1', sourceModel: 'Order' },
      planKey: 'one_time',
      monetizationType: 'purchase',
      amount: 10000,
      currency: 'BDT',
      gateway: 'manual',
      paymentData: { method: 'cash' },
    });

    await new Promise(r => setTimeout(r, 100));
    expect(handler).toHaveBeenCalled();
    expect(handler.mock.calls[0][0].monetizationType).toBe('purchase');
  });

  it('payments.verify emits payment.verified event', async () => {
    const handler = vi.fn();
    revenue.on('payment.verified', handler);

    const { transaction } = await revenue.monetization.create({
      data: { customerId: 'cust_e2', sourceId: 'order_e2', sourceModel: 'Order' },
      planKey: 'one_time',
      monetizationType: 'purchase',
      amount: 20000,
      currency: 'BDT',
      gateway: 'manual',
      paymentData: { method: 'cash' },
    });

    await revenue.payments.verify(transaction._id, { verifiedBy: 'admin_1' });

    await new Promise(r => setTimeout(r, 100));
    expect(handler).toHaveBeenCalled();
    expect(handler.mock.calls[0][0].transaction._id).toBe(transaction._id);
  });

  it('payments.refund emits payment.refunded event', async () => {
    const handler = vi.fn();
    revenue.on('payment.refunded', handler);

    const { transaction } = await revenue.monetization.create({
      data: { customerId: 'cust_e3', sourceId: 'order_e3', sourceModel: 'Order' },
      planKey: 'one_time',
      monetizationType: 'purchase',
      amount: 30000,
      currency: 'BDT',
      gateway: 'manual',
      paymentData: { method: 'cash' },
    });

    await revenue.payments.verify(transaction._id, { verifiedBy: 'admin_1' });
    await revenue.payments.refund(transaction._id, 15000, { reason: 'Partial refund' });

    await new Promise(r => setTimeout(r, 100));
    expect(handler).toHaveBeenCalled();
    expect(handler.mock.calls[0][0].refundAmount).toBe(15000);
    expect(handler.mock.calls[0][0].isPartialRefund).toBe(true);
  });
});

describe('Utility Re-exports', () => {
  it('exports Money utilities from main entry', async () => {
    const { toSmallestUnit, fromSmallestUnit } = await import('@classytic/revenue');
    expect(toSmallestUnit).toBeDefined();
    expect(fromSmallestUnit).toBeDefined();
    expect(typeof toSmallestUnit).toBe('function');
    expect(typeof fromSmallestUnit).toBe('function');
  });

  it('exports enums from /enums subpath', async () => {
    const enums = await import('@classytic/revenue/enums');
    expect(enums.TRANSACTION_STATUS).toBeDefined();
    expect(enums.TRANSACTION_FLOW).toBeDefined();
    expect(enums.PAYMENT_STATUS).toBeDefined();
    expect(enums.SUBSCRIPTION_STATUS).toBeDefined();
    expect(enums.MONETIZATION_TYPES).toBeDefined();
    expect(enums.PAYMENT_GATEWAY_TYPE).toBeDefined();
    expect(enums.PLAN_KEYS).toBeDefined();
    expect(enums.LIBRARY_CATEGORIES).toBeDefined();
    // Deprecated but still available for backward compatibility
    expect(enums.TRANSACTION_TYPE).toBeDefined();
    expect(enums.TRANSACTION_TYPE_VALUES).toBeDefined();
  });

  it('exports schemas from /schemas subpath', async () => {
    const schemas = await import('@classytic/revenue/schemas');
    expect(schemas.currentPaymentSchema).toBeDefined();
    expect(schemas.subscriptionInfoSchema).toBeDefined();
    expect(schemas.gatewaySchema).toBeDefined();
    expect(schemas.commissionSchema).toBeDefined();
  });

  it('exports definePlugin from /plugins subpath', async () => {
    const plugins = await import('@classytic/revenue/plugins');
    expect(plugins.definePlugin).toBeDefined();
    expect(typeof plugins.definePlugin).toBe('function');
  });
});

describe('Refund Utilities', () => {
  it('canRefundOrder returns eligible for verified payment', async () => {
    const { canRefundOrder } = await import('../src/shared/revenue/refund.utils.ts');

    const order = {
      currentPayment: {
        transactionId: 'txn_123',
        status: 'verified',
        amount: 50000,
      },
    };

    const result = canRefundOrder(order);
    expect(result.eligible).toBe(true);
  });

  it('canRefundOrder returns ineligible without transactionId', async () => {
    const { canRefundOrder } = await import('../src/shared/revenue/refund.utils.ts');

    const order = { currentPayment: { status: 'pending' } };
    const result = canRefundOrder(order);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('No payment transaction');
  });

  it('canRefundOrder returns ineligible for unverified payment', async () => {
    const { canRefundOrder } = await import('../src/shared/revenue/refund.utils.ts');

    const order = {
      currentPayment: { transactionId: 'txn_456', status: 'pending' },
    };
    const result = canRefundOrder(order);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('Only verified');
  });

  it('getRefundableAmount calculates remaining after partial refund', async () => {
    const { getRefundableAmount } = await import('../src/shared/revenue/refund.utils.ts');

    const order = {
      currentPayment: {
        amount: 100000,
        refundedAmount: 40000,
      },
    };

    expect(getRefundableAmount(order)).toBe(60000);
  });

  it('getRefundableAmount returns full amount when no prior refund', async () => {
    const { getRefundableAmount } = await import('../src/shared/revenue/refund.utils.ts');

    const order = {
      currentPayment: { amount: 50000 },
    };

    expect(getRefundableAmount(order)).toBe(50000);
  });

  it('getRefundableAmount returns 0 for missing payment', async () => {
    const { getRefundableAmount } = await import('../src/shared/revenue/refund.utils.ts');

    expect(getRefundableAmount({})).toBe(0);
    expect(getRefundableAmount({ currentPayment: {} })).toBe(0);
  });
});

describe('Payment Verification Utilities', () => {
  it('validatePaymentData throws without method', async () => {
    const { validatePaymentData } = await import('../src/shared/revenue/payment-verification.utils.ts');

    expect(() => validatePaymentData(null)).toThrow('Payment method is required');
    expect(() => validatePaymentData({})).toThrow('Payment method is required');
  });

  it('validatePaymentData passes with valid method', async () => {
    const { validatePaymentData } = await import('../src/shared/revenue/payment-verification.utils.ts');

    expect(() => validatePaymentData({ method: 'bkash' })).not.toThrow();
  });

  it('resolveGateway defaults to manual', async () => {
    const { resolveGateway } = await import('../src/shared/revenue/payment-verification.utils.ts');

    expect(resolveGateway(null)).toBe('manual');
    expect(resolveGateway({})).toBe('manual');
    expect(resolveGateway({ gateway: 'stripe' })).toBe('stripe');
  });
});

describe('Schema Helpers', () => {
  it('buildCurrentPayment creates correct structure', async () => {
    const { buildCurrentPayment } = await import('../src/shared/revenue/schemas.ts');

    const result = buildCurrentPayment(50000, 'bkash', 'BGH3K5L90P');
    expect(result).toEqual({
      amount: 50000,
      status: 'pending',
      method: 'bkash',
      reference: 'BGH3K5L90P',
    });
  });

  it('buildSplitPayment handles single payment', async () => {
    const { buildSplitPayment } = await import('../src/shared/revenue/schemas.ts');

    const result = buildSplitPayment(50000, [
      { method: 'cash', amount: 50000 },
    ]);

    expect(result.method).toBe('cash');
    expect(result.payments).toBeUndefined();
  });

  it('buildSplitPayment handles multiple payments', async () => {
    const { buildSplitPayment } = await import('../src/shared/revenue/schemas.ts');

    const result = buildSplitPayment(50000, [
      { method: 'cash', amount: 30000 },
      { method: 'bkash', amount: 20000, reference: 'TRX123' },
    ]);

    expect(result.method).toBe('split');
    expect(result.payments).toHaveLength(2);
    expect(result.payments[0].method).toBe('cash');
    expect(result.payments[1].reference).toBe('TRX123');
  });

  it('validateSplitPayments passes for single payment', async () => {
    const { validateSplitPayments } = await import('../src/shared/revenue/schemas.ts');

    expect(validateSplitPayments({ amount: 50000, method: 'cash' })).toBe(true);
  });

  it('validateSplitPayments validates split totals', async () => {
    const { validateSplitPayments } = await import('../src/shared/revenue/schemas.ts');

    // Matching totals
    expect(validateSplitPayments({
      amount: 50000,
      payments: [
        { method: 'cash', amount: 30000 },
        { method: 'bkash', amount: 20000 },
      ],
    })).toBe(true);

    // Mismatched totals
    expect(validateSplitPayments({
      amount: 50000,
      payments: [
        { method: 'cash', amount: 30000 },
        { method: 'bkash', amount: 10000 },
      ],
    })).toBe(false);
  });
});
