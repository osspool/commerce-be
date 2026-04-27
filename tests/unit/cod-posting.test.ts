/**
 * COD Posting Contracts (UNIT)
 *
 * Fast-tier tests for the three COD contracts — pure functions, no Mongo,
 * no Fastify, no app boot. Matches the style of business-type-posting.test.ts.
 *
 * The sum-of-debits === sum-of-credits invariant is the single most
 * important property of a journal entry. These tests enforce it across the
 * full lifecycle (placement → settlement, placement → cancellation) so a
 * future refactor can't silently break the ledger.
 *
 * Scenarios:
 *   placement        — with/without tax, with/without promo
 *   settlement       — full pay, with commission, with writeoff, mixed
 *   cancellation     — mirror of placement
 *   invariant        — placement Dr = settlement Cr (round-trip)
 *   validation       — validateCodSettlementInputs rejects unbalanced inputs
 */

import { describe, it, expect } from 'vitest';
import {
  codPlacementToPosting,
  type CodPlacementData,
} from '../../src/resources/accounting/posting/contracts/cod-placement.contract.js';
import {
  codSettlementToPosting,
  validateCodSettlementInputs,
  type CodSettlementData,
} from '../../src/resources/accounting/posting/contracts/cod-settlement.contract.js';
import {
  codCancellationToPosting,
  type CodCancellationData,
} from '../../src/resources/accounting/posting/contracts/cod-cancellation.contract.js';
import type { PostingInput } from '../../src/resources/accounting/posting/posting.service.js';

// Helper — sum debits / credits in paisa
function sumDrCr(posting: PostingInput): { dr: number; cr: number } {
  let dr = 0;
  let cr = 0;
  for (const item of posting.items) {
    dr += item.debit || 0;
    cr += item.credit || 0;
  }
  return { dr, cr };
}

function expectBalanced(posting: PostingInput) {
  const { dr, cr } = sumDrCr(posting);
  expect(dr).toBe(cr);
  expect(dr).toBeGreaterThan(0);
}

function findItem(posting: PostingInput, accountCode: string) {
  return posting.items.find((item) => item.accountCode === accountCode);
}

// ── Placement ──────────────────────────────────────────────────────────

describe('codPlacementToPosting', () => {
  const base: CodPlacementData = {
    transactionId: 'txn_1',
    orderId: 'order_1',
    amount: 115000, // 1150 BDT total
    tax: 15000, // 150 BDT VAT (~15%)
    date: new Date('2026-04-23T10:00:00Z'),
  };

  it('posts a balanced journal entry for a vanilla COD order', () => {
    const posting = codPlacementToPosting(base);
    expectBalanced(posting);
  });

  it('debits A/R 1141 with the gross amount and tags it with the order partner', () => {
    const posting = codPlacementToPosting(base);
    const ar = findItem(posting, '1141');
    expect(ar).toBeDefined();
    expect(ar!.debit).toBe(base.amount);
    expect(ar!.credit).toBe(0);
    expect(ar!.partnerId).toBe(base.orderId);
    expect(ar!.partnerType).toBe('customer');
    expect(ar!.maturityDate).toBeInstanceOf(Date);
  });

  it('credits revenue on the net-of-vat amount', () => {
    const posting = codPlacementToPosting(base);
    const revenue = findItem(posting, '4111');
    // 115000 total - 15000 VAT = 100000 net
    expect(revenue!.credit).toBe(100000);
  });

  it('credits VAT 2132 with the tax portion when tax > 0', () => {
    const posting = codPlacementToPosting(base);
    const vat = findItem(posting, '2132');
    expect(vat!.credit).toBe(15000);
  });

  it('omits the VAT line when tax is zero', () => {
    const posting = codPlacementToPosting({ ...base, amount: 100000, tax: 0 });
    expect(findItem(posting, '2132')).toBeUndefined();
    expectBalanced(posting);
  });

  it('posts promo discount as a contra-revenue debit on 4115 (keeps gross sales visible)', () => {
    const posting = codPlacementToPosting({
      ...base,
      promoDiscount: 10000, // 100 BDT promo
    });
    const discount = findItem(posting, '4115');
    expect(discount!.debit).toBe(10000);
    const revenue = findItem(posting, '4111');
    // Revenue is grossed up by the discount: (115000 - 15000) + 10000 = 110000
    expect(revenue!.credit).toBe(110000);
    expectBalanced(posting);
  });

  it('uses `cod-placed-${transactionId}` as the idempotency key', () => {
    const posting = codPlacementToPosting(base);
    expect(posting.idempotencyKey).toBe('cod-placed-txn_1');
    expect(posting.journalType).toBe('ECOM_SALES_COD');
    expect(posting.sourceRef).toEqual({ sourceModel: 'Order', sourceId: 'order_1' });
  });

  it('defaults the maturity date to +14 days from the transaction date', () => {
    const posting = codPlacementToPosting(base);
    const ar = findItem(posting, '1141');
    const maturity = ar!.maturityDate!;
    const expected = new Date(base.date);
    expected.setDate(expected.getDate() + 14);
    expect(maturity.toISOString().slice(0, 10)).toBe(expected.toISOString().slice(0, 10));
  });

  it('honors a caller-specified expectedRemittanceDays', () => {
    const posting = codPlacementToPosting({ ...base, expectedRemittanceDays: 30 });
    const ar = findItem(posting, '1141');
    const expected = new Date(base.date);
    expected.setDate(expected.getDate() + 30);
    expect(ar!.maturityDate!.toISOString().slice(0, 10)).toBe(expected.toISOString().slice(0, 10));
  });
});

// ── Settlement ─────────────────────────────────────────────────────────

describe('codSettlementToPosting', () => {
  const gross = 115000;
  const baseSettlement: Omit<CodSettlementData, 'actualReceived' | 'courierCommission' | 'writeoff'> = {
    settlementId: 'settle_1',
    orderId: 'order_1',
    grossAmount: gross,
    date: new Date('2026-04-25T10:00:00Z'),
  };

  it('full-pay: debits Bank 1112 with the whole gross, credits A/R', () => {
    const posting = codSettlementToPosting({
      ...baseSettlement,
      actualReceived: gross,
      courierCommission: 0,
      writeoff: 0,
    });
    expect(findItem(posting, '1112')!.debit).toBe(gross);
    expect(findItem(posting, '1141')!.credit).toBe(gross);
    expect(findItem(posting, '1141')!.partnerId).toBe('order_1');
    expectBalanced(posting);
  });

  it('with courier commission: splits debit between Bank and 6423 Commission', () => {
    const posting = codSettlementToPosting({
      ...baseSettlement,
      actualReceived: 110000,
      courierCommission: 5000, // 50 BDT commission
      writeoff: 0,
    });
    expect(findItem(posting, '1112')!.debit).toBe(110000);
    expect(findItem(posting, '6423')!.debit).toBe(5000);
    expect(findItem(posting, '1141')!.credit).toBe(gross);
    expectBalanced(posting);
  });

  it('with writeoff: splits debit between Bank and 6702 Bad Debt Written Off', () => {
    const posting = codSettlementToPosting({
      ...baseSettlement,
      actualReceived: 100000, // customer paid 100 BDT less
      courierCommission: 0,
      writeoff: 15000,
    });
    expect(findItem(posting, '1112')!.debit).toBe(100000);
    expect(findItem(posting, '6702')!.debit).toBe(15000);
    expect(findItem(posting, '1141')!.credit).toBe(gross);
    expectBalanced(posting);
  });

  it('mixed: bank + commission + writeoff together balance to gross', () => {
    const posting = codSettlementToPosting({
      ...baseSettlement,
      actualReceived: 95000,
      courierCommission: 10000,
      writeoff: 10000,
    });
    expect(findItem(posting, '1112')!.debit).toBe(95000);
    expect(findItem(posting, '6423')!.debit).toBe(10000);
    expect(findItem(posting, '6702')!.debit).toBe(10000);
    expect(findItem(posting, '1141')!.credit).toBe(gross);
    expectBalanced(posting);
  });

  it('respects cashAccount override (1111 Cash for in-person settlement)', () => {
    const posting = codSettlementToPosting({
      ...baseSettlement,
      actualReceived: gross,
      courierCommission: 0,
      writeoff: 0,
      cashAccount: '1111',
    });
    expect(findItem(posting, '1111')!.debit).toBe(gross);
    expect(findItem(posting, '1112')).toBeUndefined();
    expectBalanced(posting);
  });

  it('omits Bank line if actualReceived is zero (total writeoff)', () => {
    const posting = codSettlementToPosting({
      ...baseSettlement,
      actualReceived: 0,
      courierCommission: 0,
      writeoff: gross,
    });
    expect(findItem(posting, '1112')).toBeUndefined();
    expect(findItem(posting, '6702')!.debit).toBe(gross);
    expectBalanced(posting);
  });

  it('uses `cod-settled-${settlementId}` as the idempotency key', () => {
    const posting = codSettlementToPosting({
      ...baseSettlement,
      actualReceived: gross,
      courierCommission: 0,
      writeoff: 0,
    });
    expect(posting.idempotencyKey).toBe('cod-settled-settle_1');
    expect(posting.journalType).toBe('ECOM_SALES_COD_SETTLEMENT');
  });
});

// ── Validation ─────────────────────────────────────────────────────────

describe('validateCodSettlementInputs', () => {
  const base = { grossAmount: 100000, actualReceived: 100000, courierCommission: 0, writeoff: 0 };

  it('accepts a balanced payload', () => {
    expect(validateCodSettlementInputs(base)).toEqual({ ok: true });
  });

  it('accepts bank + commission summing to gross', () => {
    expect(validateCodSettlementInputs({ ...base, actualReceived: 95000, courierCommission: 5000 })).toEqual({
      ok: true,
    });
  });

  it('rejects sum that exceeds gross', () => {
    const result = validateCodSettlementInputs({ ...base, actualReceived: 100000, courierCommission: 5000 });
    expect(result.ok).toBe(false);
  });

  it('rejects sum that falls short of gross', () => {
    const result = validateCodSettlementInputs({ ...base, actualReceived: 90000 });
    expect(result.ok).toBe(false);
  });

  it('rejects non-positive grossAmount', () => {
    expect(validateCodSettlementInputs({ ...base, grossAmount: 0 }).ok).toBe(false);
    expect(validateCodSettlementInputs({ ...base, grossAmount: -100 }).ok).toBe(false);
  });

  it('rejects negative components', () => {
    expect(validateCodSettlementInputs({ ...base, actualReceived: -1, courierCommission: 100001 }).ok).toBe(false);
    expect(validateCodSettlementInputs({ ...base, writeoff: -1, courierCommission: 1, actualReceived: 100000 }).ok).toBe(
      false,
    );
  });
});

// ── Cancellation ───────────────────────────────────────────────────────

describe('codCancellationToPosting', () => {
  const base: CodCancellationData = {
    orderId: 'order_1',
    grossAmount: 115000,
    tax: 15000,
    date: new Date('2026-04-24T10:00:00Z'),
  };

  it('posts a balanced reversal for a vanilla COD cancel', () => {
    const posting = codCancellationToPosting(base);
    expectBalanced(posting);
  });

  it('reverses revenue (Dr 4111) and VAT (Dr 2132), credits A/R 1141', () => {
    const posting = codCancellationToPosting(base);
    expect(findItem(posting, '4111')!.debit).toBe(100000); // netSales
    expect(findItem(posting, '2132')!.debit).toBe(15000);
    expect(findItem(posting, '1141')!.credit).toBe(115000);
    expect(findItem(posting, '1141')!.partnerId).toBe('order_1');
  });

  it('mirrors promo by crediting 4115 Discount back', () => {
    const posting = codCancellationToPosting({ ...base, promoDiscount: 10000 });
    const discount = findItem(posting, '4115');
    expect(discount!.credit).toBe(10000);
    // Dr 4111 includes the promo add-back: 100000 + 10000 = 110000
    expect(findItem(posting, '4111')!.debit).toBe(110000);
    expectBalanced(posting);
  });

  it('uses orderId-based idempotency (one cancellation per order)', () => {
    const posting = codCancellationToPosting(base);
    expect(posting.idempotencyKey).toBe('cod-cancelled-order_1');
    expect(posting.journalType).toBe('ECOM_SALES_COD_REVERSAL');
  });
});

// ── Round-trip invariant ───────────────────────────────────────────────

describe('COD round-trip invariant', () => {
  const amount = 115000;
  const tax = 15000;
  const promoDiscount = 10000;

  it('placement Dr 1141 === settlement Cr 1141 (A/R opens and closes exactly)', () => {
    const placement = codPlacementToPosting({
      transactionId: 'txn_1',
      orderId: 'order_1',
      amount,
      tax,
      date: new Date(),
      promoDiscount,
    });
    const settlement = codSettlementToPosting({
      settlementId: 'settle_1',
      orderId: 'order_1',
      grossAmount: amount,
      actualReceived: 110000,
      courierCommission: 5000,
      writeoff: 0,
      date: new Date(),
    });
    const placementAr = findItem(placement, '1141')!.debit;
    const settlementAr = findItem(settlement, '1141')!.credit;
    expect(placementAr).toBe(settlementAr);
  });

  it('placement Dr 1141 === cancellation Cr 1141 (reversal exactly clears A/R)', () => {
    const placement = codPlacementToPosting({
      transactionId: 'txn_1',
      orderId: 'order_2',
      amount,
      tax,
      date: new Date(),
      promoDiscount,
    });
    const cancellation = codCancellationToPosting({
      orderId: 'order_2',
      grossAmount: amount,
      tax,
      promoDiscount,
      date: new Date(),
    });
    const placementAr = findItem(placement, '1141')!.debit;
    const cancellationAr = findItem(cancellation, '1141')!.credit;
    expect(placementAr).toBe(cancellationAr);
  });

  it('combined placement + cancellation nets to zero impact on the trial balance', () => {
    const placement = codPlacementToPosting({
      transactionId: 'txn_1',
      orderId: 'order_3',
      amount,
      tax,
      date: new Date(),
      promoDiscount,
    });
    const cancellation = codCancellationToPosting({
      orderId: 'order_3',
      grossAmount: amount,
      tax,
      promoDiscount,
      date: new Date(),
    });
    // Summing both entries: Dr total = Cr total AND every account nets to 0.
    const net = new Map<string, number>();
    for (const entry of [placement, cancellation]) {
      for (const item of entry.items) {
        net.set(item.accountCode, (net.get(item.accountCode) ?? 0) + (item.debit || 0) - (item.credit || 0));
      }
    }
    for (const [, balance] of net) {
      expect(balance).toBe(0);
    }
  });
});
