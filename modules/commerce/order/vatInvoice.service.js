import VatInvoiceCounter from './vatInvoiceCounter.model.js';
import { getVatConfig } from './vat.utils.js';

export function getBdDateKey(date = new Date()) {
  // Use BD local date to avoid timezone boundary issues.
  // Intl is supported in Node and does not require external deps.
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date); // YYYY-MM-DD
  return formatted.replace(/-/g, '');
}

function padNumber(num, width) {
  return String(num).padStart(width, '0');
}

export function buildVatInvoiceNumber({ prefix, branchCode, dateKey, seq, pad = 4 }) {
  const safePrefix = prefix ?? 'INV-';
  const safeBranchCode = String(branchCode || 'BR').toUpperCase();
  const safeDateKey = String(dateKey || getBdDateKey(new Date()));
  const safeSeq = Number(seq || 0);
  return `${safePrefix}${safeBranchCode}-${safeDateKey}-${padNumber(safeSeq, pad)}`;
}

/**
 * Generate a VAT invoice number for a branch (per BD day sequence).
 *
 * @param {Object} params
 * @param {Object} params.branch - Branch doc (must have _id and code)
 * @param {Date} [params.issuedAt] - Invoice issue time (default: now)
 * @param {mongoose.ClientSession|null} [params.session] - Optional Mongo session
 * @returns {Promise<{ invoiceNumber: string, dateKey: string, seq: number }>}
 */
export async function generateVatInvoiceForBranch({ branch, issuedAt = new Date(), session = null }) {
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

