import { describe, it, expect } from 'vitest';
import { buildFinanceSummary } from '../modules/finance/handlers/summary.handler.js';

describe('Finance summary formatting', () => {
  it('aggregates by day+branch and computes method breakdown', () => {
    const data = buildFinanceSummary([
      { dateKey: '2025-12-18', branchCode: 'DHK', method: 'cash', type: 'income', amountPaisa: 10000, count: 1 },
      { dateKey: '2025-12-18', branchCode: 'DHK', method: 'bkash', type: 'income', amountPaisa: 25000, count: 1 },
      { dateKey: '2025-12-18', branchCode: 'DHK', method: 'bkash', type: 'expense', amountPaisa: 5000, count: 1 },
    ]);

    expect(data.totals.incomeBdt).toBe(350);
    expect(data.totals.expenseBdt).toBe(50);
    expect(data.totals.netBdt).toBe(300);
    expect(data.byMethod.bkash.netBdt).toBe(200);
    expect(data.byDay).toHaveLength(1);
    expect(data.byDay[0].branchCode).toBe('DHK');
  });
});

