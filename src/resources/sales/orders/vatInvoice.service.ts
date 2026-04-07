import type { ClientSession, Types } from 'mongoose';
import VatInvoiceCounter from './vatInvoiceCounter.model.js';
import { getVatConfig } from './vat.utils.js';

interface Branch {
  _id: Types.ObjectId;
  code: string;
}

interface InvoiceResult {
  invoiceNumber: string;
  dateKey: string;
  seq: number;
}

export function getBdDateKey(date: Date = new Date()): string {
  // Use BD local date to avoid timezone boundary issues.
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date); // YYYY-MM-DD
  return formatted.replace(/-/g, '');
}

function padNumber(num: number, width: number): string {
  return String(num).padStart(width, '0');
}

export function buildVatInvoiceNumber({
  prefix,
  branchCode,
  dateKey,
  seq,
  pad = 4,
}: {
  prefix?: string | null;
  branchCode?: string | null;
  dateKey?: string | null;
  seq?: number | null;
  pad?: number;
}): string {
  const safePrefix = prefix ?? 'INV-';
  const safeBranchCode = String(branchCode || 'BR').toUpperCase();
  const safeDateKey = String(dateKey || getBdDateKey(new Date()));
  const safeSeq = Number(seq || 0);
  return `${safePrefix}${safeBranchCode}-${safeDateKey}-${padNumber(safeSeq, pad)}`;
}

/**
 * Generate a VAT invoice number for a branch (per BD day sequence).
 */
export async function generateVatInvoiceForBranch({
  branch,
  issuedAt = new Date(),
  session = null,
}: {
  branch: Branch;
  issuedAt?: Date;
  session?: ClientSession | null;
}): Promise<InvoiceResult> {
  if (!branch?._id || !branch?.code) {
    throw new Error('Branch is required to generate VAT invoice number');
  }

  const vatConfig = await getVatConfig();
  const prefix = vatConfig?.invoice?.prefix || 'INV-';
  const pad = vatConfig?.invoice?.pad || 4;
  const dateKey = getBdDateKey(issuedAt);

  const seq = await VatInvoiceCounter.nextSeq(branch._id, dateKey, session);
  const invoiceNumber = buildVatInvoiceNumber({ prefix, branchCode: branch.code, dateKey, seq, pad });

  return { invoiceNumber, dateKey, seq };
}
