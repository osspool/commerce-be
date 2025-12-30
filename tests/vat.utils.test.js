import { describe, it, expect } from 'vitest';

import {
  addVatToExclusive,
  calculateLineVatAmount,
  extractVatFromInclusive,
} from '../modules/sales/orders/vat.utils.js';

describe('VAT utils', () => {
  it('extracts VAT correctly for VAT-inclusive totals', () => {
    const { netPrice, vatAmount } = extractVatFromInclusive(115, 15);
    expect(netPrice).toBe(100);
    expect(vatAmount).toBe(15);
    expect(calculateLineVatAmount(115, 15, true)).toBe(15);
  });

  it('adds VAT correctly for VAT-exclusive totals', () => {
    const { grossPrice, vatAmount } = addVatToExclusive(100, 15);
    expect(grossPrice).toBe(115);
    expect(vatAmount).toBe(15);
    expect(calculateLineVatAmount(100, 15, false)).toBe(15);
  });

  it('returns 0 when VAT rate is 0', () => {
    expect(calculateLineVatAmount(100, 0, true)).toBe(0);
    expect(calculateLineVatAmount(100, 0, false)).toBe(0);
  });
});

