export function normalizeNumber(value: unknown, fallback: number = 0): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return num;
}

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
  const costPrice = normalizeNumber(item.costPrice, 0);
  const discount = Math.max(normalizeNumber(item.discount, 0), 0);
  const taxRate = Math.min(Math.max(normalizeNumber(item.taxRate, 0), 0), 100);

  const lineTotal = quantity * costPrice;
  const lineDiscount = Math.min(discount, lineTotal);
  const taxableAmount = lineTotal - lineDiscount;
  const taxAmount = taxableAmount * (taxRate / 100);

  return {
    quantity,
    costPrice,
    discount: lineDiscount,
    taxRate,
    lineTotal,
    taxableAmount,
    taxAmount,
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
  const normalizedItems = items.map((item) => {
    const totals = computeLineTotals(item);
    return {
      ...item,
      ...totals,
    };
  });

  const subTotal = normalizedItems.reduce((sum, item) => sum + (item.lineTotal || 0), 0);
  const discountTotal = normalizedItems.reduce((sum, item) => sum + (item.discount || 0), 0);
  const taxTotal = normalizedItems.reduce((sum, item) => sum + (item.taxAmount || 0), 0);
  const grandTotal = subTotal - discountTotal + taxTotal;

  return {
    items: normalizedItems,
    subTotal,
    discountTotal,
    taxTotal,
    grandTotal,
  };
}

interface PaymentStatusResult {
  paymentStatus: string;
  dueAmount: number;
  paidAmount: number;
}

export function computePaymentStatus(grandTotal: number | unknown, paidAmount: number | unknown): PaymentStatusResult {
  const total = Math.max(normalizeNumber(grandTotal, 0), 0);
  const paid = Math.max(normalizeNumber(paidAmount, 0), 0);
  const dueAmount = Math.max(total - paid, 0);

  let paymentStatus = 'unpaid';
  if (paid > 0 && dueAmount > 0) paymentStatus = 'partial';
  if (dueAmount === 0 && total > 0) paymentStatus = 'paid';

  return { paymentStatus, dueAmount, paidAmount: paid };
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
