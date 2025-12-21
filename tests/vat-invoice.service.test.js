import { describe, it, expect } from 'vitest';
import { getBdDateKey, buildVatInvoiceNumber } from '../modules/commerce/order/vatInvoice.service.js';

describe('VAT invoice utilities', () => {
  it('generates BD date key (YYYYMMDD) in Asia/Dhaka', () => {
    // 2025-01-01 00:30 in Dhaka is 2024-12-31 18:30 UTC
    const date = new Date('2024-12-31T18:30:00.000Z');
    expect(getBdDateKey(date)).toBe('20250101');
  });

  it('builds invoice number using branch+dateKey+sequence', () => {
    const invoice = buildVatInvoiceNumber({
      prefix: 'INV-',
      branchCode: 'DHK',
      dateKey: '20251218',
      seq: 7,
      pad: 4,
    });
    expect(invoice).toBe('INV-DHK-20251218-0007');
  });
});

