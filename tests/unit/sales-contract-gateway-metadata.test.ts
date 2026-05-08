/**
 * Unit test for sales posting contract — gateway metadata stamping.
 *
 * Background — settlement matching is a release blocker. At low volume the
 * amount + date matcher is fine; at scale (busy bKash days) multiple sales
 * for the same amount fall in the same window and the matcher can't
 * disambiguate. The fix carries the provider's transaction id through:
 *   sales.contract.ts → JE.metadata.gatewayTransactionId
 *   leg.externalTxnRef → matcher reads metadata for deterministic 1:1
 *
 * This test pins the contract end of that wire so a refactor can't quietly
 * drop the metadata stamping. The matcher side is exercised in the
 * settlement-matcher integration test.
 */

import { describe, it, expect } from 'vitest';
import {
  type SalesTransactionData,
  salesTransactionToPosting,
} from '../../src/resources/accounting/posting/contracts/sales.contract.js';

const baseData = (): SalesTransactionData => ({
  transactionId: 'txn-123',
  amount: 575900,
  tax: 75100,
  method: 'bkash',
  date: new Date('2026-05-05T12:00:00Z'),
  orderId: 'order-456',
  source: 'web',
});

describe('salesTransactionToPosting — settlement matcher anchor', () => {
  it('omits metadata when no gateway ref is provided (legacy path stays clean)', () => {
    const out = salesTransactionToPosting(baseData());
    expect(out.metadata).toBeUndefined();
  });

  it('stamps metadata.gatewayTransactionId when gateway ref is provided', () => {
    const out = salesTransactionToPosting({
      ...baseData(),
      gatewayTransactionId: 'BK1A2B3C4D',
    });
    expect(out.metadata).toEqual({ gatewayTransactionId: 'BK1A2B3C4D' });
  });

  it('stamps both gatewayTransactionId and gatewayProvider together', () => {
    const out = salesTransactionToPosting({
      ...baseData(),
      gatewayTransactionId: 'BK1A2B3C4D',
      gatewayProvider: 'bkash',
    });
    expect(out.metadata).toEqual({
      gatewayTransactionId: 'BK1A2B3C4D',
      gatewayProvider: 'bkash',
    });
  });

  it('drops empty gateway ref strings (so matcher does not try to match on empty string)', () => {
    const out = salesTransactionToPosting({
      ...baseData(),
      gatewayTransactionId: '',
    });
    expect(out.metadata).toBeUndefined();
  });

  it('accepts gateway provider alone (without txn id) without setting metadata.gatewayTransactionId', () => {
    const out = salesTransactionToPosting({
      ...baseData(),
      gatewayProvider: 'bkash',
    });
    expect(out.metadata).toEqual({ gatewayProvider: 'bkash' });
    expect(out.metadata?.gatewayTransactionId).toBeUndefined();
  });

  it('preserves the rest of the JE shape — JE-level fields are unaffected by the metadata stamping', () => {
    const out = salesTransactionToPosting({
      ...baseData(),
      gatewayTransactionId: 'BK1A2B3C4D',
      gatewayProvider: 'bkash',
    });
    expect(out.journalType).toBe('ECOM_SALES');
    expect(out.idempotencyKey).toBe('sale-txn-123');
    expect(out.sourceRef).toEqual({ sourceModel: 'Order', sourceId: 'order-456' });
    expect(out.autoPost).toBe(true);
    expect(out.items.length).toBeGreaterThanOrEqual(2);
  });

  it('stamps metadata for POS source too (cash sales should still carry the receipt id when available)', () => {
    const out = salesTransactionToPosting({
      ...baseData(),
      method: 'cash',
      source: 'pos',
      gatewayTransactionId: 'POS-RECEIPT-001',
      gatewayProvider: 'pos',
    });
    expect(out.journalType).toBe('POS_SALES');
    expect(out.metadata).toEqual({
      gatewayTransactionId: 'POS-RECEIPT-001',
      gatewayProvider: 'pos',
    });
  });
});
