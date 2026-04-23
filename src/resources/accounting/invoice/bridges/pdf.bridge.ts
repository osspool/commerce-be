/**
 * PDF bridge — pdfkit-backed adapter for the invoice engine.
 *
 * Renders an invoice as a Bangladesh Mushak 6.3-style tax invoice PDF.
 * Server-side generation matches the industry standard (Odoo/ERPNext/Saleor)
 * for legal tax documents — required for email attachments, customer-portal
 * download, and NBR audit archive.
 *
 * Library: pdfkit (~600KB pure JS, mature, used by Stripe/GitHub, no system
 * deps). Swapped from pdfmake in 2026-04 due to pdfmake's broken url-resolver
 * under Node 22 ESM.
 *
 * Bengali script: pdfkit ships built-in Helvetica only. Bangla support
 * requires loading a Bengali OTF font via `doc.registerFont('Bangla', path)`
 * — left as a follow-up; current invoice fields are ASCII (English partner
 * names + numeric totals).
 *
 * The bridge resolves seller info (BIN, name, VAT circle) from PlatformConfig
 * at render time so invoice PDFs always carry the live seller block — even
 * for invoices issued before a Platform.vat field was set.
 */

import type { Invoice } from '@classytic/invoice';
import type { PDFBridge, PDFGenerateOptions, PDFResult } from '@classytic/invoice/domain/contracts';
import PDFDocument from 'pdfkit';
import PlatformConfig from '#resources/platform/platform.model.js';

/** Format integer paisa as decimal currency string (e.g. 12345 → "123.45"). */
function formatAmount(paisa: number): string {
  return (paisa / 100).toFixed(2);
}

function formatDate(d?: Date | null): string {
  if (!d) return '—';
  return new Date(d).toISOString().slice(0, 10);
}

interface SellerBlock {
  bin: string;
  name: string;
  address: string;
  vatCircle?: string;
}

async function loadSeller(): Promise<SellerBlock> {
  const config = await (
    PlatformConfig as unknown as {
      getConfig: () => Promise<{ vat?: Record<string, unknown>; platformName?: string }>;
    }
  ).getConfig();
  const vat = (config.vat ?? {}) as Record<string, unknown>;
  return {
    bin: (vat.bin as string) ?? '',
    name: (vat.registeredName as string) ?? config.platformName ?? '',
    address: (vat.vatCircle as string) ?? '',
    vatCircle: vat.vatCircle as string | undefined,
  };
}

/**
 * Render the invoice into a pdfkit document. Pure layout — does no I/O.
 * Caller pipes the result into a buffer.
 */
function renderInvoice(doc: PDFKit.PDFDocument, invoice: Invoice, seller: SellerBlock): void {
  const isCustomerInvoice = invoice.moveType === 'out_invoice' || invoice.moveType === 'out_refund';
  const docTitle = isCustomerInvoice ? 'TAX INVOICE (Mushak 6.3)' : 'BILL';

  // ── Title ─────────────────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(18).text(docTitle, { align: 'center' });
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#6b7280')
    .text('Bangladesh National Board of Revenue', { align: 'center' });
  doc.moveDown(1);
  doc.fillColor('black');

  // ── Seller / Buyer side-by-side ───────────────────────────────────────
  const blockY = doc.y;
  const colWidth = (doc.page.width - 80) / 2;

  doc.font('Helvetica-Bold').fontSize(11).text('Seller', 40, blockY);
  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .text(seller.name, 40, blockY + 14);
  doc
    .font('Helvetica')
    .fontSize(9)
    .text(`BIN: ${seller.bin}`, 40, blockY + 28)
    .text(seller.address || '', 40, blockY + 40);

  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .text('Buyer', 40 + colWidth, blockY);
  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .text(invoice.partnerName ?? 'Walk-in', 40 + colWidth, blockY + 14);
  doc
    .font('Helvetica')
    .fontSize(9)
    .text(`Customer ID: ${invoice.partnerId ?? '-'}`, 40 + colWidth, blockY + 28);

  doc.y = blockY + 60;
  doc.moveDown(0.5);

  // ── Invoice meta row ──────────────────────────────────────────────────
  const metaY = doc.y;
  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .text(`Invoice No: ${invoice.number ?? 'DRAFT'}`, 40, metaY)
    .text(`Date: ${formatDate(invoice.date)}`, 40 + colWidth, metaY)
    .text(`Due: ${formatDate(invoice.dueDate)}`, doc.page.width - 140, metaY);
  doc.y = metaY + 16;
  doc.moveDown(0.5);

  // ── Line items table ──────────────────────────────────────────────────
  const tableTop = doc.y;
  const cols = [
    { x: 40, w: 24, head: '#' },
    { x: 64, w: 60, head: 'HS Code' },
    { x: 124, w: 200, head: 'Description' },
    { x: 324, w: 36, head: 'Qty', align: 'right' as const },
    { x: 360, w: 30, head: 'UoM' },
    { x: 390, w: 55, head: 'Unit', align: 'right' as const },
    { x: 445, w: 55, head: 'Subtotal', align: 'right' as const },
    { x: 500, w: 55, head: 'Total', align: 'right' as const },
  ];

  doc.font('Helvetica-Bold').fontSize(9).fillColor('#374151');
  doc.rect(40, tableTop - 2, doc.page.width - 80, 16).fill('#f3f4f6');
  doc.fillColor('#374151');
  cols.forEach((c) => {
    doc.text(c.head, c.x + 2, tableTop + 2, { width: c.w - 4, align: c.align ?? 'left' });
  });

  let rowY = tableTop + 18;
  doc.font('Helvetica').fontSize(9).fillColor('black');
  (invoice.lines ?? []).forEach((line, i) => {
    const cells: Array<{ value: string; align?: 'left' | 'right' }> = [
      { value: String(i + 1) },
      { value: line.hsCode ?? '' },
      { value: line.description ?? line.productName ?? '' },
      { value: String(line.quantity ?? 0), align: 'right' },
      { value: line.uom ?? 'pcs' },
      { value: formatAmount(line.unitPrice ?? 0), align: 'right' },
      { value: formatAmount(line.subtotal ?? 0), align: 'right' },
      { value: formatAmount(line.lineTotal ?? 0), align: 'right' },
    ];
    cells.forEach((cell, j) => {
      const c = cols[j];
      doc.text(cell.value, c.x + 2, rowY, { width: c.w - 4, align: cell.align ?? 'left' });
    });
    rowY += 14;
  });

  // Subtle row separator
  doc
    .moveTo(40, rowY)
    .lineTo(doc.page.width - 40, rowY)
    .strokeColor('#e5e7eb')
    .stroke();
  doc.y = rowY + 6;

  // ── Totals block (right-aligned) ──────────────────────────────────────
  const totalsX = doc.page.width - 240;
  const totalsW = 200;
  const labelW = 110;
  const valueW = 90;
  const valueX = totalsX + labelW;
  let totalsY = doc.y + 8;

  const totalsRows: Array<[string, string, boolean]> = [
    ['Subtotal', formatAmount(invoice.untaxedAmount ?? 0), false],
    ['Tax (VAT)', formatAmount(invoice.taxAmount ?? 0), false],
    [`Grand Total (${invoice.currency ?? 'BDT'})`, formatAmount(invoice.totalAmount ?? 0), true],
    ['Amount Paid', formatAmount((invoice.totalAmount ?? 0) - (invoice.amountDue ?? 0)), false],
    ['Amount Due', formatAmount(invoice.amountDue ?? 0), true],
  ];

  totalsRows.forEach(([label, value, bold]) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
    doc.text(label, totalsX, totalsY, { width: labelW });
    doc.text(value, valueX, totalsY, { width: valueW, align: 'right' });
    totalsY += 16;
  });
  void totalsW;

  // ── Footer ────────────────────────────────────────────────────────────
  const footerY = doc.page.height - 50;
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#6b7280')
    .text('Generated by BigBoss Commerce', 40, footerY, {
      width: doc.page.width - 80,
      align: 'center',
    });
}

export function createPdfBridge(): PDFBridge {
  return {
    async generate(invoice: Invoice, _options?: PDFGenerateOptions): Promise<PDFResult> {
      const seller = await loadSeller();
      const doc = new PDFDocument({ size: 'A4', margin: 40 });

      const chunks: Buffer[] = [];
      const finished = new Promise<Buffer>((resolve, reject) => {
        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
      });

      renderInvoice(doc, invoice, seller);
      doc.end();

      const buffer = await finished;
      return {
        buffer,
        mimeType: 'application/pdf',
        filename: `${invoice.number ?? 'DRAFT'}.pdf`,
      };
    },
  };
}
