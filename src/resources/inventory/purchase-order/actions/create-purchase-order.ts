import { createStatusError } from '#resources/inventory/shared/status-errors.js';
import { PurchaseOrderPaymentStatus, PurchaseOrderPaymentTerms, PurchaseOrderStatus } from '../purchase-order.constants.js';
import purchaseOrderRepository from '../purchase-order.repository.js';
import { buildStatusEntry, computePurchaseTotals, normalizeNumber } from '../purchase-order.utils.js';
import type { CreatePurchaseData } from './shared.js';
import { getSupplierById, normalizePurchaseItems, resolveDueDate, resolveHeadOfficeBranch } from './shared.js';
import { InventoryCounter } from '#resources/inventory/flow/counter-bridge.js';

export async function createPurchase(
  data: CreatePurchaseData,
  actorId: string | undefined,
  actions: {
    approvePurchase: (purchaseId: string, approverId: string | undefined) => Promise<unknown>;
    receivePurchase: (purchaseId: string, receiverId: string | undefined) => Promise<unknown>;
    payPurchase: (
      purchaseId: string,
      paymentData: CreatePurchaseData['payment'],
      payerId: string | undefined,
    ) => Promise<unknown>;
  },
): Promise<unknown> {
  const {
    items,
    branchId,
    supplierId,
    purchaseOrderNumber,
    invoiceDate,
    paymentTerms,
    creditDays,
    dueDate,
    notes,
    autoApprove,
    autoReceive,
    payment,
  } = data || {};

  if (!items?.length) {
    throw createStatusError('Purchase must include at least one item');
  }

  const branch = await resolveHeadOfficeBranch(branchId);
  const supplier = await getSupplierById(supplierId);
  const normalizedItems = await normalizePurchaseItems(items);
  const totals = computePurchaseTotals(normalizedItems);

  const resolvedPaymentTerms = paymentTerms || supplier?.paymentTerms || PurchaseOrderPaymentTerms.CASH;
  const resolvedCreditDays = Number.isFinite(creditDays)
    ? normalizeNumber(creditDays, 0)
    : normalizeNumber(supplier?.creditDays, 0);

  const resolvedInvoiceDate = invoiceDate ? new Date(invoiceDate) : new Date();
  const resolvedDueDate = resolveDueDate({
    paymentTerms: resolvedPaymentTerms,
    creditDays: resolvedCreditDays,
    dueDate,
    invoiceDate: resolvedInvoiceDate,
  });

  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const seq = await InventoryCounter.nextSeq('PINV', ym);
  const invoiceNumber = `PINV-${ym}-${String(seq).padStart(4, '0')}`;

  let purchase: unknown = await purchaseOrderRepository.create({
    invoiceNumber,
    purchaseOrderNumber,
    supplier: supplier?._id,
    branch: branch._id,
    invoiceDate: resolvedInvoiceDate,
    paymentTerms: resolvedPaymentTerms,
    creditDays: resolvedCreditDays,
    dueDate: resolvedDueDate,
    status: PurchaseOrderStatus.DRAFT,
    paymentStatus: PurchaseOrderPaymentStatus.UNPAID,
    items: totals.items,
    subTotal: totals.subTotal,
    discountTotal: totals.discountTotal,
    taxTotal: totals.taxTotal,
    grandTotal: totals.grandTotal,
    paidAmount: 0,
    dueAmount: totals.grandTotal,
    statusHistory: [buildStatusEntry(PurchaseOrderStatus.DRAFT, actorId, 'Purchase created')],
    createdBy: actorId,
    updatedBy: actorId,
    notes,
  });

  const purchaseId = String((purchase as { _id: unknown })._id);

  if (autoApprove || autoReceive) {
    purchase = await actions.approvePurchase(purchaseId, actorId);
  }

  if (autoReceive) {
    purchase = await actions.receivePurchase(purchaseId, actorId);
  }

  if (payment) {
    purchase = await actions.payPurchase(purchaseId, payment, actorId);
  }

  return purchase;
}
