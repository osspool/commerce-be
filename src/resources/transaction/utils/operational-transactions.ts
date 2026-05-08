import { toSmallestUnit } from '@classytic/revenue';
import type { ClientSession } from 'mongoose';
import { getTransactionModel } from '#shared/revenue/engine.js';
import { PAYMENT_METHOD_VALUES } from '#shared/revenue/enums.js';

interface PaymentDetails {
  trxId?: string;
  senderPhone?: string;
  [key: string]: unknown;
}

interface TaxDetails {
  type?: string;
  rate?: number;
  isInclusive?: boolean;
  jurisdiction?: string;
}

interface OperationalExpenseParams {
  amountBdt: number;
  category: string;
  method?: string;
  paymentDetails?: PaymentDetails;
  sourceModel?: string;
  sourceId?: string;
  branchId?: string;
  branchCode?: string;
  source?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
  verifiedBy?: string;
  date?: Date;
  session?: ClientSession | null;
  taxBdt?: number;
  taxDetails?: TaxDetails;
}

function normalizePaymentMethod(method: string | undefined | null): string {
  const normalized = String(method || '')
    .trim()
    .toLowerCase();
  if (!normalized) return 'cash';
  if ((PAYMENT_METHOD_VALUES as readonly string[]).includes(normalized)) return normalized;
  if (normalized === 'bank') return 'bank_transfer';
  return 'manual';
}

function normalizeSource(source: string | undefined | null): string {
  const normalized = String(source || '')
    .trim()
    .toLowerCase();
  if (normalized === 'web' || normalized === 'pos' || normalized === 'api') return normalized;
  return 'api';
}

/**
 * Create a verified operational expense transaction (inventory purchase, inventory loss, COGS, etc.).
 */
export async function createVerifiedOperationalExpenseTransaction(params: OperationalExpenseParams) {
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

  const transactionPayload: Record<string, unknown> = {
    amount,
    // The Transaction schema (`@classytic/revenue`) requires `currency`.
    // Hard-coded to BDT — this codebase is single-tenant Bangladesh; if we
    // ever fork to another country, this should pick up `TENANT_CURRENCY_LITERAL`
    // from `lib/tenant.ts` (FE) or its be-prod equivalent.
    currency: 'BDT',
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
    const [transaction] = await getTransactionModel().create([transactionPayload], { session });
    return transaction;
  }

  return getTransactionModel().create(transactionPayload);
}
