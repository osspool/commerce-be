/**
 * Invoice Engine Integration Tests
 *
 * Tests @classytic/invoice engine directly with MongoMemoryServer.
 * All domain verbs live on repositories.invoices (PACKAGE_RULES §1–§3, §30).
 * No service-layer calls — the repository IS the API surface.
 *
 * Covers:
 *   1. Engine initialization (new service shape)
 *   2. Customer invoice lifecycle (createDraft → post → pay → settled)
 *   3. Vendor bill lifecycle
 *   4. Credit note flow (full + partial)
 *   5. Receipt (POS) flow
 *   6. Aging report
 *   7. Cancel / void
 *   8. Mark sent / viewed / clone
 *   9. Overdue detection
 *  10. Multi-branch isolation
 *  11. Document data generation
 *  12. LedgerBridge integration
 *  13. Deposit / down-payment flow
 *  14. Early-payment discount flow
 *  15. Quote lifecycle
 *  16. Response shape compliance (raw mongokit docs, no envelopes)
 *  17. Inherited mongokit methods work (getAll, getById, findAll, count, exists)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createInvoiceEngine } from '@classytic/invoice';
import type { InvoiceEngine, Invoice } from '@classytic/invoice';

let mongod: MongoMemoryServer;
let connection: mongoose.Connection;
let engine: InvoiceEngine;

const ORG = 'branch-test-001';
const ORG2 = 'branch-test-002';
const ctx = (orgId = ORG) => ({ organizationId: orgId, actorId: 'test-user' });
const scope = (orgId = ORG) => ({ organizationId: orgId });

const ledgerCalls: { method: string; input: unknown }[] = [];
const mockLedger = {
  async createJournalEntry(input: unknown) {
    ledgerCalls.push({ method: 'createJournalEntry', input });
    return `je-${ledgerCalls.length}`;
  },
  async reverseJournalEntry(jeId: string, reason: string) {
    ledgerCalls.push({ method: 'reverseJournalEntry', input: { jeId, reason } });
    return `je-rev-${ledgerCalls.length}`;
  },
  async recordPayment(input: unknown) {
    ledgerCalls.push({ method: 'recordPayment', input });
    return `je-pay-${ledgerCalls.length}`;
  },
};

const mockTax = {
  calculateLineTax(line: { subtotal: number }) {
    const taxAmount = Math.round(line.subtotal * 0.15);
    return { taxAmount, taxRate: 0.15, taxCode: 'VAT_15' };
  },
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  connection = mongoose.createConnection(mongod.getUri());
  await connection.asPromise();

  engine = createInvoiceEngine({
    mongoose: connection,
    currency: 'BDT',
    scope: { strategy: 'field', field: 'organizationId', required: false },
    ledger: mockLedger,
    tax: mockTax,
    dunning: { schedule: [-3, 0, 7, 14], gracePeriodDays: 3 },
    lateFee: { rate: 0.02, period: 'monthly', graceDays: 5 },
    idempotency: true,
  });
});

afterAll(async () => {
  await connection.close();
  await mongod.stop();
});

function sampleInvoice(overrides = {}) {
  return {
    moveType: 'out_invoice' as const,
    partnerId: 'cust-001',
    partnerName: 'Acme Corp',
    lines: [{ description: 'Widget A', quantity: 10, unitPrice: 500 }],
    ...overrides,
  };
}

function sampleBill(overrides = {}) {
  return {
    moveType: 'in_invoice' as const,
    partnerId: 'vendor-001',
    partnerName: 'SupplyChain Ltd',
    lines: [{ description: 'Raw Materials', quantity: 100, unitPrice: 200 }],
    ...overrides,
  };
}

const repo = () => engine.repositories.invoices;

// ── 1. Engine Initialization ──────────────────────────────────────────────

describe('Engine Initialization', () => {
  it('engine.services only has surviving services (no invoice/posting/payment/creditNote/receipt)', () => {
    const keys = Object.keys(engine.services);
    expect(keys).toContain('aging');
    expect(keys).toContain('batch');
    expect(keys).toContain('dunning');
    expect(keys).toContain('paymentTerm');
    expect(keys).toContain('recurring');
    expect(keys).toContain('sequence');
    expect(keys).not.toContain('invoice');
    expect(keys).not.toContain('posting');
    expect(keys).not.toContain('payment');
    expect(keys).not.toContain('creditNote');
    expect(keys).not.toContain('receipt');
  });

  it('repositories expose all domain verbs', () => {
    // Quote / proforma workflow moved to @classytic/order — those verbs no
    // longer live on InvoiceRepository.
    const proto = Object.getPrototypeOf(repo());
    const verbs = [
      'post', 'cancel', 'void', 'unpost', 'submit', 'approve', 'reject',
      'recordPayment', 'reversePayment', 'creditNoteFull', 'creditNotePartial',
      'createReceipt', 'createPaidReceipt', 'createDepositInvoice',
      'clone', 'markSent', 'markViewed', 'addLine', 'updateLine', 'removeLine',
      'createDraft', 'updateDraft', 'deleteDraft', 'maybeCreateLateFee',
    ];
    for (const v of verbs) {
      expect(typeof proto[v]).toBe('function');
    }
  });

  it('introspect reports capabilities', () => {
    expect(engine.introspect.capabilities().ledger).toBe(true);
    expect(engine.introspect.capabilities().tax).toBe(true);
    // Move types: out_invoice, in_invoice, out_refund, in_refund, receipt.
    expect(engine.introspect.moveTypes()).toHaveLength(5);
  });
});

// ── 2. Customer Invoice Lifecycle ─────────────────────────────────────────

describe('Customer Invoice Lifecycle', () => {
  let invoiceId: string;

  it('createDraft → returns raw doc with correct shape', async () => {
    const inv = await repo().createDraft(sampleInvoice(), ctx());
    invoiceId = inv._id;
    expect(inv.status).toBe('draft');
    expect(inv.paymentStatus).toBe('not_paid');
    expect(inv.number).toBeNull();
    expect(inv.untaxedAmount).toBe(5000);
    expect(inv.totalAmount).toBe(5000);
    expect(inv.currency).toBe('BDT');
    expect(inv._id).toBeTruthy();
    expect(inv.createdAt).toBeInstanceOf(Date);
  });

  it('post → assigns number, computes tax, posts to ledger', async () => {
    const posted = await repo().post(invoiceId, ctx());
    expect(posted.status).toBe('posted');
    expect(posted.number).toBeTruthy();
    expect(posted.taxAmount).toBe(750);
    expect(posted.totalAmount).toBe(5750);
    expect(posted.journalEntryId).toBeTruthy();
    expect(posted.postedAt).toBeInstanceOf(Date);
  });

  it('recordPayment (partial) → paymentStatus=partial', async () => {
    const alloc = await repo().recordPayment({
      invoiceId, paymentId: 'pay-1', amount: 3000, method: 'card',
    }, ctx());

    expect(alloc.amount).toBe(3000);
    expect(alloc.invoiceId).toBe(invoiceId);

    const inv = await repo().getById(invoiceId, scope());
    expect(inv?.paymentStatus).toBe('partial');
    expect(inv?.amountPaid).toBe(3000);
    expect(inv?.amountDue).toBe(2750);
  });

  it('recordPayment (remainder) → paymentStatus=paid', async () => {
    await repo().recordPayment({
      invoiceId, paymentId: 'pay-2', amount: 2750, method: 'cash',
    }, ctx());

    const inv = await repo().getById(invoiceId, scope());
    expect(inv?.paymentStatus).toBe('paid');
    expect(inv?.amountDue).toBe(0);
    expect(inv?.paidAt).toBeInstanceOf(Date);
  });
});

// ── 3. Vendor Bill Lifecycle ──────────────────────────────────────────────

describe('Vendor Bill Lifecycle', () => {
  it('create → post → pay', async () => {
    const draft = await repo().createDraft(sampleBill(), ctx());
    expect(draft.moveType).toBe('in_invoice');

    const posted = await repo().post(draft._id, ctx());
    expect(posted.number).toBeTruthy();

    await repo().recordPayment({
      invoiceId: posted._id, paymentId: 'bill-pay-1', amount: posted.totalAmount, method: 'bank_transfer',
    }, ctx());

    const paid = await repo().getById(posted._id, scope());
    expect(paid?.paymentStatus).toBe('paid');
  });
});

// ── 4. Credit Note Flow ──────────────────────────────────────────────────

describe('Credit Note Flow', () => {
  it('creates full credit note from posted invoice', async () => {
    const draft = await repo().createDraft(sampleInvoice(), ctx());
    const posted = await repo().post(draft._id, ctx());

    const cn = await repo().creditNoteFull(posted._id, ctx());
    expect(cn.moveType).toBe('out_refund');
    expect(String(cn.originInvoiceId)).toBe(String(posted._id));
    expect(cn.lines).toHaveLength(1);
    expect(cn.status).toBe('draft');
  });
});

// ── 5. Receipt (POS) Flow ─────────────────────────────────────────────────

describe('Receipt Flow', () => {
  it('createReceipt → draft + post in one call', async () => {
    const receipt = await repo().createReceipt({
      partnerId: 'walk-in', partnerName: 'Walk-in Customer',
      lines: [{ description: 'POS Sale', quantity: 1, unitPrice: 15000 }],
    }, ctx());

    expect(receipt.moveType).toBe('receipt');
    expect(receipt.status).toBe('posted');
    expect(receipt.number).toBeTruthy();
  });

  it('createPaidReceipt → posted + paid', async () => {
    const { receipt, payment } = await repo().createPaidReceipt({
      partnerId: 'walk-in',
      lines: [{ description: 'Cash Sale', quantity: 1, unitPrice: 5000 }],
      paymentId: 'pos-txn-001', method: 'cash',
    }, ctx());

    expect(receipt.status).toBe('posted');
    expect(payment.amount).toBe(receipt.totalAmount);

    const inv = await repo().getById(receipt._id, scope());
    expect(inv?.paymentStatus).toBe('paid');
  });
});

// ── 6. Aging Report ───────────────────────────────────────────────────────

describe('Aging Report', () => {
  it('generates aging report with buckets', async () => {
    const d = await repo().createDraft({
      ...sampleInvoice({ partnerId: 'aging-cust' }),
      dueDate: new Date('2025-01-01'),
    }, ctx());
    await repo().post(d._id, ctx());

    const report = await engine.services.aging.agingReport(ctx(), {
      side: 'receivable', buckets: [30, 60, 90],
    });

    expect(report.buckets).toHaveLength(4);
    expect(report.grandTotal).toBeGreaterThan(0);
  });
});

// ── 7. Cancel / Void ──────────────────────────────────────────────────────

describe('Cancel and Void', () => {
  it('cancels unpaid posted invoice', async () => {
    const d = await repo().createDraft(sampleInvoice(), ctx());
    const p = await repo().post(d._id, ctx());
    const cancelled = await repo().cancel(p._id, 'error in invoice', ctx());
    expect(cancelled.status).toBe('cancelled');
  });

  it('voids even if partially paid', async () => {
    const d = await repo().createDraft(sampleInvoice(), ctx());
    const p = await repo().post(d._id, ctx());
    await repo().recordPayment({
      invoiceId: p._id, paymentId: 'void-pay', amount: 1000, method: 'cash',
    }, ctx());

    const voided = await repo().void(p._id, 'incorrect invoice', ctx());
    expect(voided.status).toBe('voided');
  });

  it('rejects cancel on paid invoice', async () => {
    const d = await repo().createDraft(sampleInvoice(), ctx());
    const p = await repo().post(d._id, ctx());
    await repo().recordPayment({
      invoiceId: p._id, paymentId: 'full-pay', amount: p.totalAmount, method: 'cash',
    }, ctx());

    await expect(repo().cancel(p._id, 'test', ctx())).rejects.toThrow('no payments');
  });
});

// ── 8. Mark Sent / Viewed / Clone ─────────────────────────────────────────

describe('Invoice Actions', () => {
  it('marks invoice as sent', async () => {
    const d = await repo().createDraft(sampleInvoice(), ctx());
    const p = await repo().post(d._id, ctx());
    const sent = await repo().markSent(p._id, ctx());
    expect(sent.sentAt).toBeInstanceOf(Date);
  });

  it('marks invoice as viewed', async () => {
    const d = await repo().createDraft(sampleInvoice(), ctx());
    const p = await repo().post(d._id, ctx());
    const viewed = await repo().markViewed(p._id, ctx());
    expect(viewed.viewedAt).toBeInstanceOf(Date);
  });

  it('clones as new draft', async () => {
    const d = await repo().createDraft(sampleInvoice(), ctx());
    const p = await repo().post(d._id, ctx());
    const cloned = await repo().clone(p._id, { notes: 'Cloned' }, ctx());
    expect(cloned.status).toBe('draft');
    expect(cloned.notes).toBe('Cloned');
    expect(cloned.lines).toHaveLength(p.lines.length);
    expect(cloned._id).not.toBe(p._id);
  });
});

// ── 9. Overdue Detection ──────────────────────────────────────────────────

describe('Overdue Detection', () => {
  it('finds overdue invoices', async () => {
    const d = await repo().createDraft({
      ...sampleInvoice({ partnerId: 'overdue-cust' }),
      dueDate: new Date('2024-01-01'),
    }, ctx());
    await repo().post(d._id, ctx());

    const overdue = await repo().getOverdue(new Date(), scope());
    expect(overdue.length).toBeGreaterThanOrEqual(1);
    expect(overdue.some((inv: Invoice) => String(inv._id) === String(d._id))).toBe(true);
  });
});

// ── 10. Multi-Branch Isolation ────────────────────────────────────────────

describe('Multi-Branch Isolation', () => {
  it('invoices are scoped to branch', async () => {
    await repo().createDraft(sampleInvoice(), ctx(ORG));
    await repo().createDraft(sampleInvoice(), ctx(ORG2));

    const org1Result = await repo().getAll({}, scope(ORG));
    const org2Result = await repo().getAll({}, scope(ORG2));
    const org1 = (org1Result as { docs?: Invoice[] }).docs ?? (org1Result as unknown as Invoice[]);
    const org2 = (org2Result as { docs?: Invoice[] }).docs ?? (org2Result as unknown as Invoice[]);

    expect(org1.length).toBeGreaterThanOrEqual(1);
    expect(org2.length).toBeGreaterThanOrEqual(1);
    expect(org2.every((inv: Invoice) => !org1.some((i: Invoice) => String(i._id) === String(inv._id)))).toBe(true);
  });

  it('getById returns null for cross-branch access', async () => {
    const inv = await repo().createDraft(sampleInvoice(), ctx(ORG));
    const crossBranch = await repo().getById(inv._id, { ...scope(ORG2), throwOnNotFound: false });
    expect(crossBranch).toBeNull();
  });
});

// ── 11. Document Data ─────────────────────────────────────────────────────

describe('Document Data', () => {
  it('generates document data for PDF/print', async () => {
    const { toDocumentData } = await import('@classytic/invoice');
    const d = await repo().createDraft(sampleInvoice(), ctx());
    const p = await repo().post(d._id, ctx());

    const doc = toDocumentData(p);
    expect(doc.partnerId).toBe('cust-001');
    expect(doc.isPaid).toBe(false);
    expect(doc.lines).toHaveLength(1);
  });
});

// ── 12. LedgerBridge Integration ──────────────────────────────────────────

describe('LedgerBridge Integration', () => {
  it('calls createJournalEntry on post', async () => {
    const before = ledgerCalls.length;
    const d = await repo().createDraft(sampleInvoice(), ctx());
    await repo().post(d._id, ctx());
    expect(ledgerCalls.slice(before).filter(c => c.method === 'createJournalEntry')).toHaveLength(1);
  });

  it('calls reverseJournalEntry on cancel', async () => {
    const before = ledgerCalls.length;
    const d = await repo().createDraft(sampleInvoice(), ctx());
    const p = await repo().post(d._id, ctx());
    await repo().cancel(p._id, 'test', ctx());
    expect(ledgerCalls.slice(before).filter(c => c.method === 'reverseJournalEntry')).toHaveLength(1);
  });

  it('calls recordPayment on payment', async () => {
    const before = ledgerCalls.length;
    const d = await repo().createDraft(sampleInvoice(), ctx());
    const p = await repo().post(d._id, ctx());
    await repo().recordPayment({
      invoiceId: p._id, paymentId: 'bridge-test', amount: p.totalAmount, method: 'bank',
    }, ctx());
    expect(ledgerCalls.slice(before).filter(c => c.method === 'recordPayment')).toHaveLength(1);
  });
});

// ── 13. Deposit / Down Payment ────────────────────────────────────────────

describe('Deposit / Down Payment', () => {
  it('tracks deposit metadata on createDraft', async () => {
    const inv = await repo().createDraft({
      moveType: 'out_invoice', partnerId: 'deposit-cust',
      lines: [
        { description: 'Construction', quantity: 1, unitPrice: 100000, isDeposit: true, depositPercentage: 50 },
        { description: 'Finishing', quantity: 1, unitPrice: 50000 },
      ],
    }, ctx());

    expect(inv.hasDepositLines).toBe(true);
    expect(inv.depositAmount).toBe(50000);
    expect(inv.totalAmount).toBe(150000);
  });

  it('createDepositInvoice → separate advance invoice', async () => {
    const inv = await repo().createDraft({
      moveType: 'out_invoice', partnerId: 'dep-cust-2',
      lines: [{ description: 'Big Order', quantity: 1, unitPrice: 200000, isDeposit: true, depositPercentage: 30 }],
    }, ctx());

    const dep = await repo().createDepositInvoice(inv._id, ctx());
    expect(dep.sourceType).toBe('Deposit');
    expect(dep.totalAmount).toBe(60000);

    const updated = await repo().getById(inv._id, scope());
    expect(updated?.depositInvoiceId).toBe(String(dep._id));
  });

  it('rejects deposit on non-deposit invoices', async () => {
    const inv = await repo().createDraft(sampleInvoice(), ctx());
    await expect(repo().createDepositInvoice(inv._id, ctx())).rejects.toThrow('no deposit');
  });

  it('deposit invoice can be posted + paid independently', async () => {
    const inv = await repo().createDraft({
      moveType: 'out_invoice', partnerId: 'dep-cust-3',
      lines: [{ description: 'Item', quantity: 1, unitPrice: 80000, isDeposit: true }],
    }, ctx());
    const dep = await repo().createDepositInvoice(inv._id, ctx());
    const posted = await repo().post(dep._id, ctx());
    expect(posted.status).toBe('posted');

    await repo().recordPayment({
      invoiceId: dep._id, paymentId: 'dep-pay', amount: posted.totalAmount, method: 'bank_transfer',
    }, ctx());
    const paid = await repo().getById(dep._id, scope());
    expect(paid?.paymentStatus).toBe('paid');
  });
});

// ── 14. Early-Payment Discount ────────────────────────────────────────────

describe('Early-Payment Discount', () => {
  it('settles invoice with cash + discount (2/10 Net 30)', async () => {
    const d = await repo().createDraft({
      moveType: 'out_invoice', partnerId: 'disc-cust',
      lines: [{ description: 'Consulting', quantity: 1, unitPrice: 100000 }],
    }, ctx());
    const p = await repo().post(d._id, ctx());
    const discount = Math.round(p.totalAmount * 0.02);
    const cashAmount = p.totalAmount - discount;

    const alloc = await repo().recordPayment({
      invoiceId: p._id, paymentId: 'disc-pay', amount: cashAmount, method: 'bank',
      discountAmount: discount,
    }, ctx());

    expect(alloc.discountAmount).toBe(discount);
    const settled = await repo().getById(p._id, scope());
    expect(settled?.paymentStatus).toBe('paid');
    expect(settled?.amountDue).toBe(0);
  });

  it('rejects when cash + discount exceeds balance', async () => {
    const d = await repo().createDraft(sampleInvoice(), ctx());
    const p = await repo().post(d._id, ctx());

    await expect(repo().recordPayment({
      invoiceId: p._id, paymentId: 'over', amount: p.totalAmount, method: 'cash',
      discountAmount: 100,
    }, ctx())).rejects.toThrow('exceeds');
  });

  it('reversal un-settles both cash and discount', async () => {
    const d = await repo().createDraft({
      moveType: 'out_invoice', partnerId: 'rev-disc',
      lines: [{ description: 'X', quantity: 1, unitPrice: 50000 }],
    }, ctx());
    const p = await repo().post(d._id, ctx());

    const alloc = await repo().recordPayment({
      invoiceId: p._id, paymentId: 'rev-d', amount: 48500, method: 'card', discountAmount: 1000,
    }, ctx());

    await repo().reversePayment(alloc._id, 'mistake', ctx());
    const restored = await repo().getById(p._id, scope());
    expect(restored?.paymentStatus).toBe('not_paid');
    expect(restored?.amountDue).toBe(p.totalAmount);
  });
});

// ── 15. Quote Lifecycle (moved out of @classytic/invoice) ─────────────────
// Quote / proforma workflow now lives in @classytic/order. The invoice
// package no longer ships `out_quote` move type or quote* verbs.

// ── 16. Response Shape Compliance ─────────────────────────────────────────

describe('Response Shape Compliance', () => {
  it('createDraft returns raw doc — no { success, data } envelope', async () => {
    const inv = await repo().createDraft(sampleInvoice(), ctx());
    expect(inv).toHaveProperty('_id');
    expect(inv).toHaveProperty('status');
    expect(inv).toHaveProperty('lines');
    expect(inv).not.toHaveProperty('success');
    expect(inv).not.toHaveProperty('data');
  });

  it('post returns raw doc', async () => {
    const d = await repo().createDraft(sampleInvoice(), ctx());
    const p = await repo().post(d._id, ctx());
    expect(p).toHaveProperty('_id');
    expect(p).toHaveProperty('number');
    expect(p).not.toHaveProperty('success');
  });

  it('recordPayment returns raw PaymentAllocation doc', async () => {
    const d = await repo().createDraft(sampleInvoice(), ctx());
    const p = await repo().post(d._id, ctx());
    const alloc = await repo().recordPayment({
      invoiceId: p._id, paymentId: 'shape-test', amount: p.totalAmount, method: 'cash',
    }, ctx());
    expect(alloc).toHaveProperty('_id');
    expect(alloc).toHaveProperty('amount');
    expect(alloc).toHaveProperty('invoiceId');
    expect(alloc).not.toHaveProperty('success');
  });
});

// ── 17. Inherited Mongokit Methods Work ───────────────────────────────────

describe('Inherited Mongokit Methods', () => {
  it('getAll with pagination', async () => {
    const result = await repo().getAll({ page: 1, limit: 5 }, scope()) as any;
    expect(result).toHaveProperty('docs');
    expect(Array.isArray(result.docs)).toBe(true);
  });

  it('getById returns single doc or null', async () => {
    const inv = await repo().createDraft(sampleInvoice(), ctx());
    const found = await repo().getById(inv._id, scope());
    expect(found?._id).toEqual(inv._id);

    const notFound = await repo().getById('000000000000000000000000', { ...scope(), throwOnNotFound: false });
    expect(notFound).toBeNull();
  });

  it('findAll with filters', async () => {
    await repo().createDraft({ ...sampleInvoice(), partnerId: 'findall-test' }, ctx());
    const results = await repo().findAll({ partnerId: 'findall-test' }, scope());
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((inv: Invoice) => inv.partnerId === 'findall-test')).toBe(true);
  });

  it('count works', async () => {
    const c = await repo().count({}, scope());
    expect(typeof c).toBe('number');
    expect(c).toBeGreaterThan(0);
  });

  it('update returns updated doc', async () => {
    const inv = await repo().createDraft(sampleInvoice(), ctx());
    const updated = await repo().update(inv._id, { notes: 'updated-note' }, scope());
    expect(updated.notes).toBe('updated-note');
    expect(updated).toHaveProperty('_id');
    expect(updated).not.toHaveProperty('success');
  });

  it('delete works on draft', async () => {
    const inv = await repo().createDraft(sampleInvoice(), ctx());
    await repo().delete(inv._id, scope());
    const gone = await repo().getById(inv._id, { ...scope(), includeDeleted: false, throwOnNotFound: false });
    expect(gone).toBeNull();
  });
});
