/**
 * Purchase Money Math — paisa-integer arithmetic.
 *
 * All BDT amounts are computed in *paisa* (1/100 BDT) as integers, then
 * divided back to BDT at the boundary. IEEE 754 floats can't represent
 * `0.1` exactly, so naive `+ / *` on currency amounts accumulates
 * rounding error per line — over a multi-line purchase that drift can
 * flip `paid` → `partial` and corrupt the Mushak 9.1 input-VAT credit.
 *
 * Quantity stays a float because Flow allows fractional UoMs (e.g. kg,
 * litres). The float-multiply at the line level (`qty * unitPaisa`) is
 * rounded to the nearest paisa before any cross-line aggregation, which
 * keeps the totals deterministic regardless of input order.
 */

import { takaToPaisa, paisaToTaka } from '#shared/money.js';

export function normalizeNumber(value: unknown, fallback: number = 0): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return num;
}

// Boundary conversions route through the single BDT-pinned money authority
// (`#shared/money` → `@classytic/primitives`). `normalizeNumber` guards the
// untrusted-input case before handing a finite value to the primitive.
const toPaisa = (value: unknown): number => takaToPaisa(normalizeNumber(value, 0));
const fromPaisa = (paisa: number): number => paisaToTaka(paisa);

interface LineItemInput {
  quantity?: number | unknown;
  costPrice?: number | unknown;
  discount?: number | unknown;
  taxRate?: number | unknown;
}

interface LineTotals {
  quantity: number;
  costPrice: number;
  discount: number;
  taxRate: number;
  lineTotal: number;
  taxableAmount: number;
  taxAmount: number;
}

export function computeLineTotals(item: LineItemInput): LineTotals {
  const quantity = normalizeNumber(item.quantity, 0);
  const costPaisa = toPaisa(item.costPrice);
  const discountPaisa = Math.max(toPaisa(item.discount), 0);
  const taxRate = Math.min(Math.max(normalizeNumber(item.taxRate, 0), 0), 100);

  const lineTotalPaisa = Math.round(quantity * costPaisa);
  const lineDiscountPaisa = Math.min(discountPaisa, lineTotalPaisa);
  const taxablePaisa = lineTotalPaisa - lineDiscountPaisa;
  const taxAmountPaisa = Math.round((taxablePaisa * taxRate) / 100);

  return {
    quantity,
    costPrice: fromPaisa(costPaisa),
    discount: fromPaisa(lineDiscountPaisa),
    taxRate,
    lineTotal: fromPaisa(lineTotalPaisa),
    taxableAmount: fromPaisa(taxablePaisa),
    taxAmount: fromPaisa(taxAmountPaisa),
  };
}

interface PurchaseTotalsResult {
  items: Array<LineItemInput & LineTotals>;
  subTotal: number;
  discountTotal: number;
  taxTotal: number;
  grandTotal: number;
}

export function computePurchaseTotals(items: LineItemInput[] = []): PurchaseTotalsResult {
  const normalizedItems = items.map((item) => ({ ...item, ...computeLineTotals(item) }));

  // Aggregate in paisa to avoid float drift across many lines, then convert
  // back at the very end. Stays exact through multi-thousand-line bulk POs.
  let subPaisa = 0;
  let discountPaisa = 0;
  let taxPaisa = 0;
  for (const item of normalizedItems) {
    subPaisa += toPaisa(item.lineTotal);
    discountPaisa += toPaisa(item.discount);
    taxPaisa += toPaisa(item.taxAmount);
  }
  const grandPaisa = subPaisa - discountPaisa + taxPaisa;

  return {
    items: normalizedItems,
    subTotal: fromPaisa(subPaisa),
    discountTotal: fromPaisa(discountPaisa),
    taxTotal: fromPaisa(taxPaisa),
    grandTotal: fromPaisa(grandPaisa),
  };
}

interface PaymentStatusResult {
  paymentStatus: string;
  dueAmount: number;
  paidAmount: number;
}

/**
 * Compare grand total and paid amount in paisa so 999.99 + 0.01 always
 * evaluates to 1000 (paid), not 999.999... (still partial). Caller-side
 * additions should use `addPaisa` rather than naive float `+`.
 */
export function computePaymentStatus(grandTotal: number | unknown, paidAmount: number | unknown): PaymentStatusResult {
  const totalPaisa = Math.max(toPaisa(grandTotal), 0);
  const paidPaisa = Math.max(toPaisa(paidAmount), 0);
  const duePaisa = Math.max(totalPaisa - paidPaisa, 0);

  let paymentStatus = 'unpaid';
  if (paidPaisa > 0 && duePaisa > 0) paymentStatus = 'partial';
  if (duePaisa === 0 && totalPaisa > 0) paymentStatus = 'paid';

  return {
    paymentStatus,
    dueAmount: fromPaisa(duePaisa),
    paidAmount: fromPaisa(paidPaisa),
  };
}

/**
 * Add two BDT amounts using integer-paisa arithmetic. Avoids
 * `999.99 + 0.01 -> 999.9999999999999` artefacts on cumulative payments.
 */
export function addBdt(a: number | unknown, b: number | unknown): number {
  return fromPaisa(toPaisa(a) + toPaisa(b));
}

/**
 * Take a fraction of an amount in BDT, rounding the result to the
 * nearest paisa. Use for proportional tax / discount allocation.
 */
export function applyRatioBdt(amount: number | unknown, ratio: number | unknown): number {
  const amountPaisa = toPaisa(amount);
  const ratioNum = normalizeNumber(ratio, 0);
  return fromPaisa(Math.round(amountPaisa * ratioNum));
}

interface StatusEntry {
  status: string;
  actor: string | { toString(): string } | undefined;
  timestamp: Date;
  notes: string | undefined;
}

export function buildStatusEntry(
  status: string,
  actorId: string | { toString(): string } | undefined,
  notes: string | undefined,
): StatusEntry {
  return {
    status,
    actor: actorId,
    timestamp: new Date(),
    notes,
  };
}
