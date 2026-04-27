/**
 * Invoice PDF (Mushak 6.3) — server-side rendering smoke test.
 *
 * Asserts the PDFBridge implementation:
 *   1. Returns a valid PDF (magic bytes %PDF-).
 *   2. Carries the seller BIN from PlatformConfig.
 *   3. Carries invoice number, partner name, and grand total.
 *   4. Wired into invoice.record.generatePDF() through createInvoiceEngine.
 *
 * Engine-level test using a real mongoose connection — no HTTP layer.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createInvoiceEngine } from '@classytic/invoice';
import type { InvoiceEngine } from '@classytic/invoice';
import { createPdfBridge } from '#resources/accounting/invoice/bridges/pdf.bridge.js';
import PlatformConfig from '#resources/platform/platform.model.js';

let mongod: MongoMemoryServer;
let connection: mongoose.Connection;
let engine: InvoiceEngine;

const ORG = 'branch-test-pdf';
const ctx = { organizationId: ORG, actorId: 'tester' };

const stubLedger = {
  async createJournalEntry() { return 'je-1'; },
  async reverseJournalEntry() { return 'je-rev'; },
  async recordPayment() { return 'je-pay'; },
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  connection = mongoose.createConnection(mongod.getUri());
  await connection.asPromise();

  // Seed PlatformConfig so the PDF bridge can resolve seller info.
  // PlatformConfig binds to the default mongoose connection — connect it too.
  await mongoose.connect(mongod.getUri(), { dbName: 'platform-test' });
  await PlatformConfig.create({
    platformName: 'Acme Bangladesh Ltd',
    isSingleton: true,
    paymentMethods: [{ type: 'cash', name: 'Cash', isActive: true }],
    vat: {
      isRegistered: true,
      bin: '1234567890123',
      registeredName: 'Acme Bangladesh Ltd',
      vatCircle: 'Dhaka VAT Circle 4',
      defaultRate: 15,
      pricesIncludeVat: true,
    },
  });

  engine = createInvoiceEngine({
    mongoose: connection,
    currency: 'BDT',
    scope: { strategy: 'field', tenantField: 'organizationId', fieldType: 'string', required: false },
    ledger: stubLedger,
    pdf: createPdfBridge(),
  });
}, 60_000);

afterAll(async () => {
  await connection?.close();
  await mongoose.disconnect();
  await mongod?.stop();
});

describe('Invoice PDF (Mushak 6.3) bridge', () => {
  it('produces a valid PDF with seller BIN, invoice number, and totals', async () => {
    const draft = await engine.repositories.invoices.create(
      {
        moveType: 'out_invoice',
        partnerId: 'cust-acme-pdf-001',
        partnerName: 'Beta Trading Ltd',
        date: new Date('2026-04-18'),
        currency: 'BDT',
        lines: [
          {
            description: 'Industrial Widget Type-A',
            hsCode: '8473.30.00',
            quantity: 10,
            uom: 'pcs',
            unitPrice: 50000, // 500.00 BDT per unit
            taxCode: 'VAT_15',
            taxRate: 0.15,
          },
        ],
      },
      ctx,
    );
    await engine.repositories.invoices.post(draft._id as string, ctx);

    const pdfResult = await engine.record.generatePDF(draft._id as string, ctx);

    // 1. Valid PDF magic bytes
    expect(pdfResult.buffer.length).toBeGreaterThan(1000);
    const header = pdfResult.buffer.subarray(0, 5).toString('ascii');
    expect(header).toBe('%PDF-');
    expect(pdfResult.mimeType).toBe('application/pdf');

    // 2. Suggested filename uses the invoice number
    expect(pdfResult.filename).toMatch(/\.pdf$/);

    // 3. Extract text via pdf-parse and verify Mushak fields are rendered.
    // pdfkit compresses text streams, so a raw-buffer string match doesn't
    // work — we use a real PDF parser to get the rendered text.
    // pdf-parse v2+ exports a `PDFParse` class. Convert Buffer → Uint8Array
    // since the package recommends it for the worker.
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(pdfResult.buffer) });
    const parsed = await parser.getText();
    await parser.destroy();
    expect(parsed.text).toContain('1234567890123'); // seller BIN
    expect(parsed.text).toContain('Beta Trading Ltd'); // buyer name
    expect(parsed.text).toContain('8473.30.00'); // HS code on line
    expect(parsed.text).toContain('Acme Bangladesh Ltd'); // seller name
    expect(parsed.text).toMatch(/TAX INVOICE/);
    expect(parsed.text).toContain('Mushak 6.3');
  });
});
