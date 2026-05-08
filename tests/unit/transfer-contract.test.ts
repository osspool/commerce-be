/**
 * Unit tests for the inter-branch transfer posting contract.
 *
 * Pure input → output. Pins the JE shape (account codes, debit/credit
 * sides, idempotency key format) so a refactor that accidentally swaps
 * them at the kernel level fails here loudly.
 */

import { describe, expect, it } from 'vitest';
import {
  transferDispatchReversalToPosting,
  transferDispatchToPosting,
  transferReceiveReversalToPosting,
  transferReceiveToPosting,
} from '../../src/resources/accounting/posting/contracts/transfer.contract.js';

describe('transferDispatchToPosting', () => {
  const baseInput = {
    transferId: 'tr-1',
    documentNumber: 'TRF-202604-0001',
    goodsCost: 25000, // paisa = ৳250
    date: new Date('2026-04-29T10:00:00Z'),
  };

  it('builds an INVENTORY journal entry with two balanced lines', () => {
    const out = transferDispatchToPosting(baseInput);

    expect(out.journalType).toBe('INVENTORY');
    expect(out.label).toBe('Transfer Dispatch — TRF-202604-0001');
    expect(out.items).toHaveLength(2);
    expect(out.items[0].debit + out.items[1].debit).toBe(25000);
    expect(out.items[0].credit + out.items[1].credit).toBe(25000);
  });

  it('debits 1179 Inventory in Transit and credits 1164 Merchandise', () => {
    const out = transferDispatchToPosting(baseInput);

    const dr = out.items.find((i) => i.debit > 0);
    const cr = out.items.find((i) => i.credit > 0);

    expect(dr?.accountCode).toBe('1179');
    expect(dr?.debit).toBe(25000);
    expect(cr?.accountCode).toBe('1164');
    expect(cr?.credit).toBe(25000);
  });

  it('uses transfer-{id}-dispatch as the idempotency key', () => {
    const out = transferDispatchToPosting(baseInput);
    expect(out.idempotencyKey).toBe('transfer-tr-1-dispatch');
  });

  it('attaches a Transfer sourceRef so the JE links back to the source doc', () => {
    const out = transferDispatchToPosting(baseInput);
    expect(out.sourceRef).toEqual({ sourceModel: 'Transfer', sourceId: 'tr-1' });
  });

  it('auto-posts by default (matches the COGS / vendor-bill convention)', () => {
    const out = transferDispatchToPosting(baseInput);
    expect(out.autoPost).toBe(true);
  });

  it('respects an explicit autoPost: false override (draft-only mode)', () => {
    const out = transferDispatchToPosting(baseInput, { autoPost: false });
    expect(out.autoPost).toBe(false);
  });

  it('forwards costMissing metadata for the audit trail', () => {
    const out = transferDispatchToPosting({
      ...baseInput,
      goodsCost: 0,
      metadata: { costMissing: true, affectedSkus: ['SKU-A'] },
    });
    expect(out.metadata).toEqual({ costMissing: true, affectedSkus: ['SKU-A'] });
    expect(out.items[0].debit).toBe(0);
    expect(out.items[1].credit).toBe(0);
  });

  it('omits the metadata key entirely when no metadata is provided', () => {
    const out = transferDispatchToPosting(baseInput);
    expect('metadata' in out).toBe(false);
  });
});

describe('transferReceiveToPosting', () => {
  const baseInput = {
    transferId: 'tr-2',
    documentNumber: 'TRF-202604-0002',
    goodsCost: 75000,
    date: new Date('2026-04-29T11:00:00Z'),
  };

  it('mirrors the dispatch JE — same accounts, opposite sides', () => {
    const out = transferReceiveToPosting(baseInput);
    const dr = out.items.find((i) => i.debit > 0);
    const cr = out.items.find((i) => i.credit > 0);

    // Receive: Dr 1164 Merchandise / Cr 1179 In-Transit (clears the dispatch leg)
    expect(dr?.accountCode).toBe('1164');
    expect(dr?.debit).toBe(75000);
    expect(cr?.accountCode).toBe('1179');
    expect(cr?.credit).toBe(75000);
  });

  it('uses transfer-{id}-receive as the idempotency key (distinct from dispatch)', () => {
    const out = transferReceiveToPosting(baseInput);
    expect(out.idempotencyKey).toBe('transfer-tr-2-receive');
  });

  it('balances debits and credits', () => {
    const out = transferReceiveToPosting(baseInput);
    const totalDr = out.items.reduce((s, i) => s + i.debit, 0);
    const totalCr = out.items.reduce((s, i) => s + i.credit, 0);
    expect(totalDr).toBe(totalCr);
  });

  it('labels the JE as "Transfer Receive"', () => {
    const out = transferReceiveToPosting(baseInput);
    expect(out.label).toBe('Transfer Receive — TRF-202604-0002');
  });

  it('shares the same sourceRef as the dispatch leg (links both legs to one transfer)', () => {
    const out = transferReceiveToPosting(baseInput);
    expect(out.sourceRef).toEqual({ sourceModel: 'Transfer', sourceId: 'tr-2' });
  });

  // ── Transit cost capitalization (IAS 2) ───────────────────────────────
  describe('with transitCost > 0 (capitalized into receiver inventory)', () => {
    const inputWithTransit = { ...baseInput, transitCost: 5000 }; // ৳50

    it('uplifts the receiver merchandise debit by transitCost', () => {
      const out = transferReceiveToPosting(inputWithTransit);
      const merchDebit = out.items.find((i) => i.accountCode === '1164' && i.debit > 0);
      // Goods 75000 + transit 5000 = 80000
      expect(merchDebit?.debit).toBe(80000);
    });

    it('credits 1179 only for goodsCost (clears the dispatch leg)', () => {
      const out = transferReceiveToPosting(inputWithTransit);
      const transitCleared = out.items.find((i) => i.accountCode === '1179' && i.credit > 0);
      expect(transitCleared?.credit).toBe(75000);
    });

    it('credits 2126 Transfer Cost Clearing for transitCost (host clears later)', () => {
      const out = transferReceiveToPosting(inputWithTransit);
      const transferClearing = out.items.find((i) => i.accountCode === '2126' && i.credit > 0);
      expect(transferClearing?.credit).toBe(5000);
    });

    it('still balances debits and credits after the 3rd line is added', () => {
      const out = transferReceiveToPosting(inputWithTransit);
      const totalDr = out.items.reduce((s, i) => s + i.debit, 0);
      const totalCr = out.items.reduce((s, i) => s + i.credit, 0);
      expect(totalDr).toBe(totalCr);
      expect(totalDr).toBe(80000); // 75k goods + 5k transit
    });

    it('omits the 1159 line when transitCost is 0 (no zero-amount noise)', () => {
      const out = transferReceiveToPosting({ ...baseInput, transitCost: 0 });
      expect(out.items.find((i) => i.accountCode === '2126')).toBeUndefined();
      expect(out.items).toHaveLength(2);
    });

    it('treats negative transitCost as zero (defensive)', () => {
      const out = transferReceiveToPosting({ ...baseInput, transitCost: -100 });
      expect(out.items.find((i) => i.accountCode === '2126')).toBeUndefined();
      expect(out.items).toHaveLength(2);
    });
  });
});

describe('idempotency key uniqueness', () => {
  it('dispatch and receive keys are distinct for the same transfer (so both legs post)', () => {
    const dispatch = transferDispatchToPosting({
      transferId: 'tr-3',
      documentNumber: 'TRF-X',
      goodsCost: 100,
      date: new Date(),
    });
    const receive = transferReceiveToPosting({
      transferId: 'tr-3',
      documentNumber: 'TRF-X',
      goodsCost: 100,
      date: new Date(),
    });
    expect(dispatch.idempotencyKey).not.toBe(receive.idempotencyKey);
  });

  it('all four contract keys are distinct for the same transfer', () => {
    const base = { transferId: 'tr-99', documentNumber: 'TRF-99', goodsCost: 100, date: new Date() };
    const keys = [
      transferDispatchToPosting(base).idempotencyKey,
      transferReceiveToPosting(base).idempotencyKey,
      transferDispatchReversalToPosting(base).idempotencyKey,
      transferReceiveReversalToPosting(base).idempotencyKey,
    ];
    expect(new Set(keys).size).toBe(4);
  });
});

describe('transferDispatchReversalToPosting', () => {
  const baseInput = {
    transferId: 'tr-rev-1',
    documentNumber: 'TRF-REV-001',
    goodsCost: 25000,
    date: new Date('2026-04-29T12:00:00Z'),
  };

  it('flips the dispatch leg — Dr 1164 / Cr 1179 (stock returns to sender)', () => {
    const out = transferDispatchReversalToPosting(baseInput);
    const dr = out.items.find((i) => i.debit > 0);
    const cr = out.items.find((i) => i.credit > 0);

    expect(dr?.accountCode).toBe('1164');
    expect(dr?.debit).toBe(25000);
    expect(cr?.accountCode).toBe('1179');
    expect(cr?.credit).toBe(25000);
  });

  it('uses transfer-{id}-dispatch-reversed key (distinct from forward)', () => {
    const out = transferDispatchReversalToPosting(baseInput);
    expect(out.idempotencyKey).toBe('transfer-tr-rev-1-dispatch-reversed');
  });

  it('embeds the cancellation reason in the JE label when provided', () => {
    const out = transferDispatchReversalToPosting({ ...baseInput, reason: 'wrong vendor' });
    expect(out.label).toContain('REVERSED');
    expect(out.label).toContain('wrong vendor');
  });

  it('reuses the same Transfer sourceRef as the forward leg (audit pairs)', () => {
    const fwd = transferDispatchToPosting(baseInput);
    const rev = transferDispatchReversalToPosting(baseInput);
    expect(rev.sourceRef).toEqual(fwd.sourceRef);
  });

  it('balances debits and credits', () => {
    const out = transferDispatchReversalToPosting(baseInput);
    const totalDr = out.items.reduce((s, i) => s + i.debit, 0);
    const totalCr = out.items.reduce((s, i) => s + i.credit, 0);
    expect(totalDr).toBe(totalCr);
  });
});

describe('transferReceiveReversalToPosting', () => {
  const baseInput = {
    transferId: 'tr-rev-2',
    documentNumber: 'TRF-REV-002',
    goodsCost: 50000,
    date: new Date('2026-04-29T13:00:00Z'),
  };

  it('flips the receive leg — Dr 1179 / Cr 1164 (stock removed from receiver)', () => {
    const out = transferReceiveReversalToPosting(baseInput);
    const dr = out.items.find((i) => i.debit > 0);
    const cr = out.items.find((i) => i.credit > 0);

    expect(dr?.accountCode).toBe('1179');
    expect(dr?.debit).toBe(50000);
    expect(cr?.accountCode).toBe('1164');
    expect(cr?.credit).toBe(50000);
  });

  it('uses transfer-{id}-receive-reversed key', () => {
    const out = transferReceiveReversalToPosting(baseInput);
    expect(out.idempotencyKey).toBe('transfer-tr-rev-2-receive-reversed');
  });
});
