import { toSmallestUnit } from '@classytic/revenue';
import { PAYMENT_METHOD_VALUES } from '#common/revenue/enums.js';
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
 * - `amount` is stored in smallest unit (paisa for BDT)
 * - `referenceModel/referenceId` are used (not `reference`)
 * - `paymentDetails` is used (not `paymentData`)
 */
export async function createVerifiedOperationalExpenseTransaction(params) {
  const {
    amountBdt,
    category,
    method,
    paymentDetails,
    referenceModel = 'Manual',
    referenceId = undefined,
    branchId = undefined,
    source = 'api',
    notes = undefined,
    metadata = undefined,
    verifiedBy = undefined,
    transactionDate = new Date(),
    session = null,
  } = params || {};

  const normalizedAmountBdt = Number(amountBdt);
  if (!Number.isFinite(normalizedAmountBdt) || normalizedAmountBdt <= 0) {
    throw new Error('amountBdt must be a positive number');
  }
  if (!category) throw new Error('category is required');

  const amount = toSmallestUnit(normalizedAmountBdt, 'BDT');

  const transactionPayload = {
    amount,
    type: 'expense',
    category: String(category),
    method: normalizePaymentMethod(method),
    status: 'verified',
    source: normalizeSource(source),
    ...(branchId ? { branch: branchId } : {}),
    gateway: { type: 'manual' },
    ...(paymentDetails ? { paymentDetails } : {}),
    ...(referenceId ? { referenceId } : {}),
    referenceModel: String(referenceModel || 'Manual'),
    ...(metadata ? { metadata } : {}),
    ...(notes ? { notes } : {}),
    ...(verifiedBy ? { verifiedBy, verifiedAt: new Date() } : {}),
    transactionDate,
  };

  if (session) {
    const [transaction] = await Transaction.create([transactionPayload], { session });
    return transaction;
  }

  return Transaction.create(transactionPayload);
}
