import { describe, it, expect } from 'vitest';
import {
  parseDateParams,
  enrichBudgetVsActual,
  projectGeneralLedger,
  type GLAccount,
} from '../src/resources/accounting/reports/reports.utils.js';

describe('parseDateParams', () => {
  it('defaults to current year when nothing provided', () => {
    const result = parseDateParams({});
    expect(result.dateOption).toBe('year');
    expect(result.dateValue).toBe(new Date().getFullYear());
  });

  it('parses explicit year', () => {
    expect(parseDateParams({ dateOption: 'year', year: '2023' })).toEqual({
      dateOption: 'year',
      dateValue: 2023,
    });
  });

  it('parses custom range', () => {
    const r = parseDateParams({
      dateOption: 'custom',
      startDate: '2024-01-01',
      endDate: '2024-03-31',
    });
    expect(r.dateOption).toBe('custom');
    if (r.dateOption === 'custom') {
      expect(r.dateValue.start.getUTCFullYear()).toBe(2024);
      expect(r.dateValue.end.getUTCMonth()).toBe(2);
    }
  });

  it('falls back to year when custom is missing dates', () => {
    expect(parseDateParams({ dateOption: 'custom' }).dateOption).toBe('year');
  });

  it('parses quarter', () => {
    expect(parseDateParams({ dateOption: 'quarter', quarter: '2', year: '2024' })).toEqual({
      dateOption: 'quarter',
      dateValue: { quarter: 2, year: 2024 },
    });
  });

  it('parses month from date param', () => {
    const r = parseDateParams({ dateOption: 'month', date: '2024-05-15' });
    expect(r.dateOption).toBe('month');
    if (r.dateOption === 'month') {
      expect(r.dateValue.getUTCFullYear()).toBe(2024);
    }
  });
});

describe('enrichBudgetVsActual', () => {
  const start = new Date('2024-01-01T00:00:00Z');
  const end = new Date('2024-12-31T00:00:00Z'); // 365 days
  const halfway = new Date('2024-07-01T12:00:00Z'); // ~half year

  it('computes theoretical = budget * timeRatio at halfway', () => {
    const result = enrichBudgetVsActual(
      [{ budgetAmount: 12000, actualAmount: 6000 }],
      start,
      end,
      halfway,
    );
    // ~50% time elapsed
    expect(result.rows[0].theoreticalAmount).toBeGreaterThan(5800);
    expect(result.rows[0].theoreticalAmount).toBeLessThan(6200);
    expect(result.rows[0].burnRate).toBeCloseTo(1, 1);
  });

  it('clamps days elapsed to total period (now > end)', () => {
    const result = enrichBudgetVsActual(
      [{ budgetAmount: 1000, actualAmount: 1000 }],
      start,
      end,
      new Date('2025-06-01'),
    );
    expect(result.rows[0].theoreticalAmount).toBe(1000);
  });

  it('clamps days elapsed to zero (now < start)', () => {
    const result = enrichBudgetVsActual(
      [{ budgetAmount: 1000, actualAmount: 0 }],
      start,
      end,
      new Date('2023-06-01'),
    );
    expect(result.rows[0].theoreticalAmount).toBe(0);
    expect(result.rows[0].burnRate).toBe(0);
  });

  it('avgBurnRate ignores rows with zero theoretical', () => {
    const result = enrichBudgetVsActual(
      [
        { budgetAmount: 0, actualAmount: 100 },
        { budgetAmount: 1000, actualAmount: 500 },
      ],
      start,
      end,
      end,
    );
    // Only second row counts (theoretical = 1000, actual 500 → 0.5)
    expect(result.avgBurnRate).toBe(0.5);
  });

  it('handles empty rows', () => {
    const result = enrichBudgetVsActual([], start, end, halfway);
    expect(result.rows).toEqual([]);
    expect(result.totalTheoreticalAmount).toBe(0);
    expect(result.avgBurnRate).toBe(0);
  });

  it('guards against zero-length period', () => {
    const result = enrichBudgetVsActual(
      [{ budgetAmount: 1000, actualAmount: 100 }],
      start,
      start,
      start,
    );
    // totalDays clamped to 1, daysElapsed = 0 → ratio 0
    expect(result.rows[0].theoreticalAmount).toBe(0);
  });
});

describe('projectGeneralLedger', () => {
  const acct = (over: Partial<GLAccount> = {}): GLAccount => ({
    account: {
      _id: 'a1',
      accountTypeCode: 'ASSET',
      accountNumber: '1000',
      name: 'Cash',
      isCashAccount: true,
    },
    openingBalance: 0,
    closingBalance: 0,
    entries: [],
    ...over,
  });

  it('drops accounts with no activity', () => {
    expect(projectGeneralLedger([acct()])).toEqual([]);
  });

  it('keeps accounts with opening balance', () => {
    expect(projectGeneralLedger([acct({ openingBalance: 100 })])).toHaveLength(1);
  });

  it('keeps accounts with closing balance', () => {
    expect(projectGeneralLedger([acct({ closingBalance: 50 })])).toHaveLength(1);
  });

  it('keeps accounts with entries', () => {
    expect(projectGeneralLedger([acct({ entries: [{ id: 1 }] })])).toHaveLength(1);
  });

  it('projects only whitelisted account fields', () => {
    const result = projectGeneralLedger([
      acct({
        openingBalance: 10,
        // biome-ignore lint/suspicious/noExplicitAny: testing extra-field stripping
        account: { ...acct().account, secret: 'leak' } as any,
      }),
    ]);
    expect(Object.keys(result[0].account).sort()).toEqual([
      '_id',
      'accountNumber',
      'accountTypeCode',
      'isCashAccount',
      'name',
    ]);
  });
});
