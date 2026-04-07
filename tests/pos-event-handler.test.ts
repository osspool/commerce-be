import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PosTransactionJobData } from '#resources/sales/pos/pos.events.js';

// ============================================
// MOCKS — vi.hoisted() ensures variables are
// available when vi.mock factories run (hoisted)
// ============================================

const {
  mockMonetizationCreate,
  mockPaymentsVerify,
  mockTransactionFindById,
  mockTransactionFindByIdAndUpdate,
  mockOrderUpdate,
} = vi.hoisted(() => ({
  mockMonetizationCreate: vi.fn(),
  mockPaymentsVerify: vi.fn(),
  mockTransactionFindById: vi.fn(),
  mockTransactionFindByIdAndUpdate: vi.fn(),
  mockOrderUpdate: vi.fn(),
}));

vi.mock('#lib/events/arcEvents.js', () => ({
  subscribe: vi.fn(),
}));

vi.mock('#shared/revenue/revenue.plugin.js', () => ({
  getRevenue: () => ({
    monetization: { create: mockMonetizationCreate },
    payments: { verify: mockPaymentsVerify },
  }),
}));

vi.mock('#resources/transaction/transaction.model.js', () => ({
  default: {
    findById: mockTransactionFindById,
    findByIdAndUpdate: mockTransactionFindByIdAndUpdate,
  },
}));

vi.mock('#resources/sales/orders/order.repository.js', () => ({
  default: {
    update: mockOrderUpdate,
  },
}));

vi.mock('#lib/utils/logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// ============================================
// IMPORTS (after mocks)
// ============================================

import { handleCreateTransaction, registerPosEventHandlers } from '#resources/sales/pos/pos.events.js';
import { subscribe } from '#lib/events/arcEvents.js';

// ============================================
// HELPERS
// ============================================

function makeJobData(overrides: Partial<PosTransactionJobData> = {}): PosTransactionJobData {
  return {
    orderId: 'order-001',
    customerId: 'cust-001',
    totalAmount: 1500,
    branchId: 'branch-001',
    branchCode: 'DHK-1',
    cashierId: 'cashier-001',
    paymentMethod: 'cash',
    idempotencyKey: `idem-${Date.now()}`,
    ...overrides,
  };
}

function makeJob(dataOverrides: Partial<PosTransactionJobData> = {}) {
  return { jobId: 'test-job-1', data: makeJobData(dataOverrides) };
}

// ============================================
// TESTS
// ============================================

describe('POS Event Handler — handleCreateTransaction', () => {
  const fakeTransactionId = 'txn-abc-123';

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: monetization.create returns a transaction
    mockMonetizationCreate.mockResolvedValue({
      transaction: { _id: fakeTransactionId },
    });

    // Transaction.findById returns existing doc with amount/fee
    mockTransactionFindById.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ amount: 150000, fee: 0 }),
      }),
    });

    mockTransactionFindByIdAndUpdate.mockResolvedValue({});
    mockPaymentsVerify.mockResolvedValue({});
    mockOrderUpdate.mockResolvedValue({});
  });

  // ------------------------------------------
  // Core: creates a revenue transaction
  // ------------------------------------------
  it('creates a revenue transaction with the correct amount in smallest unit (paisa)', async () => {
    const job = makeJob({ totalAmount: 1500 });

    const result = await handleCreateTransaction(job);

    expect(mockMonetizationCreate).toHaveBeenCalledOnce();

    const createArgs = mockMonetizationCreate.mock.calls[0][0];
    // 1500 BDT => 150000 paisa
    expect(createArgs.amount).toBe(150000);
    expect(createArgs.currency).toBe('BDT');
    expect(createArgs.gateway).toBe('manual');
    expect(createArgs.planKey).toBe('one_time');
    expect(createArgs.monetizationType).toBe('purchase');
    expect(createArgs.data.sourceModel).toBe('Order');
    expect(createArgs.data.sourceId).toBe('order-001');

    expect(result.transactionId).toBe(fakeTransactionId);
  });

  // ------------------------------------------
  // Idempotency key is forwarded
  // ------------------------------------------
  it('passes idempotency key to the revenue service to prevent duplicates', async () => {
    const job = makeJob({ idempotencyKey: 'unique-key-xyz' });

    await handleCreateTransaction(job);

    const createArgs = mockMonetizationCreate.mock.calls[0][0];
    expect(createArgs.idempotencyKey).toBe('unique-key-xyz');
  });

  // ------------------------------------------
  // VAT details are applied
  // ------------------------------------------
  it('applies VAT tax details to the transaction when VAT is applicable', async () => {
    const job = makeJob({
      vatApplicable: true,
      vatAmount: 225,
      vatRate: 15,
      vatPricesIncludeVat: true,
      vatInvoiceNumber: 'VAT-2026-001',
      vatSellerBin: '123456789',
    });

    await handleCreateTransaction(job);

    // Transaction.findByIdAndUpdate is called with the tax fields
    expect(mockTransactionFindByIdAndUpdate).toHaveBeenCalledOnce();
    const [id, update] = mockTransactionFindByIdAndUpdate.mock.calls[0];

    expect(id).toBe(fakeTransactionId);
    expect(update.source).toBe('pos');
    // 225 BDT => 22500 paisa
    expect(update.tax).toBe(22500);
    expect(update.taxDetails).toEqual({
      type: 'vat',
      rate: 0.15,
      isInclusive: true,
      jurisdiction: 'BD',
    });
    // net = amount - fee - tax = 150000 - 0 - 22500 = 127500
    expect(update.net).toBe(127500);
  });

  it('sets tax to 0 when VAT is not applicable', async () => {
    const job = makeJob({ vatApplicable: false });

    await handleCreateTransaction(job);

    const [, update] = mockTransactionFindByIdAndUpdate.mock.calls[0];
    expect(update.tax).toBe(0);
    expect(update.taxDetails).toBeUndefined();
  });

  // ------------------------------------------
  // Auto-verify for POS
  // ------------------------------------------
  it('auto-verifies the transaction via payments.verify for POS', async () => {
    const job = makeJob({ cashierId: 'cashier-77' });

    await handleCreateTransaction(job);

    expect(mockPaymentsVerify).toHaveBeenCalledWith(fakeTransactionId, {
      verifiedBy: 'cashier-77',
    });
  });

  // ------------------------------------------
  // Order payment updated
  // ------------------------------------------
  it('updates the order currentPayment.transactionId after transaction creation', async () => {
    const job = makeJob({ orderId: 'order-555' });

    await handleCreateTransaction(job);

    expect(mockOrderUpdate).toHaveBeenCalledWith('order-555', {
      'currentPayment.transactionId': fakeTransactionId,
    });
  });

  // ------------------------------------------
  // Walk-in customer resolves to null
  // ------------------------------------------
  it('resolves walk-in customer ID to null', async () => {
    const job = makeJob({ customerId: 'walk-in' });

    await handleCreateTransaction(job);

    const createArgs = mockMonetizationCreate.mock.calls[0][0];
    expect(createArgs.data.customerId).toBeNull();
  });

  it('resolves empty customer ID to null', async () => {
    const job = makeJob({ customerId: '' });

    await handleCreateTransaction(job);

    const createArgs = mockMonetizationCreate.mock.calls[0][0];
    expect(createArgs.data.customerId).toBeNull();
  });

  // ------------------------------------------
  // Split payment metadata
  // ------------------------------------------
  it('records split payment flag in metadata when paymentMethod is split', async () => {
    const job = makeJob({
      paymentMethod: 'split',
      paymentPayments: [
        { method: 'cash', amount: 500 },
        { method: 'card', amount: 1000 },
      ],
    });

    await handleCreateTransaction(job);

    const createArgs = mockMonetizationCreate.mock.calls[0][0];
    expect(createArgs.metadata.isSplitPayment).toBe(true);
    expect(createArgs.paymentData.payments).toEqual([
      { method: 'cash', amount: 500 },
      { method: 'card', amount: 1000 },
    ]);
  });

  // ------------------------------------------
  // Handles null transaction from revenue
  // ------------------------------------------
  it('returns null transactionId and skips updates when revenue returns no transaction', async () => {
    mockMonetizationCreate.mockResolvedValue({ transaction: null });

    const job = makeJob();
    const result = await handleCreateTransaction(job);

    expect(result.transactionId).toBeUndefined();
    // Should NOT try to update or verify
    expect(mockTransactionFindByIdAndUpdate).not.toHaveBeenCalled();
    expect(mockPaymentsVerify).not.toHaveBeenCalled();
    expect(mockOrderUpdate).not.toHaveBeenCalled();
  });

  // ------------------------------------------
  // POS metadata fields
  // ------------------------------------------
  it('includes branch, terminal, and cashier in transaction metadata', async () => {
    const job = makeJob({
      branchCode: 'CTG-MAIN',
      terminalId: 'T-05',
      cashierId: 'cashier-42',
    });

    await handleCreateTransaction(job);

    const createArgs = mockMonetizationCreate.mock.calls[0][0];
    expect(createArgs.metadata.source).toBe('pos');
    expect(createArgs.metadata.branchCode).toBe('CTG-MAIN');
    expect(createArgs.metadata.terminalId).toBe('T-05');
    expect(createArgs.metadata.cashierId).toBe('cashier-42');
  });
});

// ============================================
// Event registration
// ============================================

describe('registerPosEventHandlers', () => {
  it('subscribes to the pos:transaction.create event', () => {
    registerPosEventHandlers();

    expect(subscribe).toHaveBeenCalledWith(
      'pos:transaction.create',
      expect.any(Function),
    );
  });

  it('registered handler delegates to handleCreateTransaction with event payload', async () => {
    registerPosEventHandlers();

    // Grab the handler that was registered
    const subscribeCalls = vi.mocked(subscribe).mock.calls;
    const lastCall = subscribeCalls[subscribeCalls.length - 1];
    const handler = lastCall[1] as (event: unknown) => Promise<void>;

    const payload = makeJobData({ orderId: 'event-order-1' });

    // Reset to track this specific call
    mockMonetizationCreate.mockResolvedValue({ transaction: { _id: 'txn-event-1' } });
    mockTransactionFindById.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ amount: 150000, fee: 0 }),
      }),
    });

    await handler({ payload });

    const createArgs = mockMonetizationCreate.mock.calls[mockMonetizationCreate.mock.calls.length - 1][0];
    expect(createArgs.data.sourceId).toBe('event-order-1');
  });
});
