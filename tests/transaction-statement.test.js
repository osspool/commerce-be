import { describe, it, expect } from 'vitest';
import { formatStatementRows } from '../modules/transaction/handlers/statement.handler.js';

describe('Transaction statement formatting', () => {
  it('maps core fields and converts paisa to BDT', () => {
    const rows = formatStatementRows([
      {
        _id: 't1',
        date: '2025-12-18T10:00:00.000Z',
        createdAt: '2025-12-18T10:00:01.000Z',
        status: 'verified',
        flow: 'inflow',
        type: 'order_purchase',
        source: 'pos',
        method: 'bkash',
        amount: 12345,
        net: 12345,
        currency: 'BDT',
        sourceModel: 'Order',
        sourceId: 'o1',
        branch: { _id: 'b1', code: 'DHK' },
        order: { _id: 'o1', customerName: 'A', vat: { invoiceNumber: 'INV-DHK-20251218-0001', sellerBin: 'BIN' } },
        metadata: { paymentReference: 'TRX' },
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].amountBdt).toBe(123.45);
    expect(rows[0].vatInvoiceNumber).toBe('INV-DHK-20251218-0001');
    expect(rows[0].branchCode).toBe('DHK');
  });
});

