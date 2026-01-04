import { toSmallestUnit } from '@classytic/revenue';
import { PAYMENT_METHOD_VALUES } from '#shared/revenue/enums.js';
import Transaction from '../transaction.model.js';

function normalizePaymentMethod(method) {
  const normalized = String(method || '').trim().toLowerCase();
  if (!normalized) return 'cash';
  if (PAYMENT_METHOD_VALUES.includes(normalized)) return normalized;
  if (normalized === 'bank') return 'bank_transfer';
  return 'manual';
}

function normalizeSource(source) {
  const normalized = String(source || '').trim().toLowerCase();
  if (normalized === 'web' || normalized === 'pos' || normalized === 'api') return normalized;
  return 'api';
}

/**
 * Create a verified operational expense transaction (inventory purchase, inventory loss, COGS, etc.).
 *
 * NOTE: This is intentionally small and schema-aligned. These transactions are not created via
 * `@classytic/revenue` monetization flows, but they must still follow the same model shape:
 * - `flow: 'outflow'` for expenses
 * - `type` is the category (inventory_purchase, cogs, etc.)
 * - `amount` is stored in smallest unit (paisa for BDT)
 * - `net` is amount after fees/tax
 * - `sourceModel/sourceId` for polymorphic references
 * - `paymentDetails` is used (not `paymentData`)
 * - `tax`/`taxDetails` for finance reporting (optional)
 */
export async function createVerifiedOperationalExpenseTransaction(params) {
  const {
    amountBdt,
    category,
    method,
    paymentDetails,
    sourceModel = 'Manual',
    sourceId = undefined,
    branchId = undefined,
    branchCode = undefined,
    source = 'api',
    notes = undefined,
    metadata = undefined,
    verifiedBy = undefined,
    date,
    session = null,
    // Tax support for B2B purchases (supplier VAT)
    taxBdt = 0,
    taxDetails = undefined,
  } = params || {};

  const normalizedAmountBdt = Number(amountBdt);
  if (!Number.isFinite(normalizedAmountBdt) || normalizedAmountBdt <= 0) {
    throw new Error('amountBdt must be a positive number');
  }
  if (!category) throw new Error('category is required');

  const amount = toSmallestUnit(normalizedAmountBdt, 'BDT');
  const tax = taxBdt > 0 ? toSmallestUnit(Number(taxBdt), 'BDT') : 0;
  // Align with revenue transaction model: net = amount - fee - tax
  const net = amount - tax;

  const transactionPayload = {
    amount,
    net,
    tax,
    flow: 'outflow',
    type: String(category),
    method: normalizePaymentMethod(method),
    status: 'verified',
    source: normalizeSource(source),
    ...(branchId ? { branch: branchId } : {}),
    ...(branchCode ? { branchCode } : {}),
    gateway: { type: 'manual' },
    ...(paymentDetails ? { paymentDetails } : {}),
    ...(sourceId ? { sourceId } : {}),
    sourceModel: String(sourceModel || 'Manual'),
    ...(metadata ? { metadata } : {}),
    ...(notes ? { notes } : {}),
    ...(verifiedBy ? { verifiedBy, verifiedAt: new Date() } : {}),
    ...(taxDetails ? { taxDetails } : {}),
    date: date || new Date(),
  };

  if (session) {
    const [transaction] = await Transaction.create([transactionPayload], { session });
    return transaction;
  }

  return Transaction.create(transactionPayload);
}
