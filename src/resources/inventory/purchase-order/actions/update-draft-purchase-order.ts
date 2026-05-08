import { createStatusError } from '#resources/inventory/shared/status-errors.js';
import type { IPurchaseOrder } from '../purchase-order.constants.js';
import purchaseOrderRepository from '../purchase-order.repository.js';
import { computePaymentStatus, computePurchaseTotals, normalizeNumber } from '../purchase-order.utils.js';
import type { PurchaseWithId, UpdatePurchaseData } from './shared.js';
import { getSupplierById, normalizePurchaseItems, resolveDueDate } from './shared.js';

export async function updateDraftPurchase(
  purchaseId: string,
  data: UpdatePurchaseData,
  actorId: string | undefined,
  assertState: (action: string, currentState: string, errorFactory: typeof createStatusError, message: string) => void,
): Promise<unknown> {
  const purchase = (await purchaseOrderRepository.getById(purchaseId, { lean: true })) as PurchaseWithId | null;
  if (!purchase) throw createStatusError('Purchase not found', 404);
  assertState('update', purchase.status, createStatusError, 'Only draft purchases can be updated');

  const updates: Record<string, unknown> = {};
  if (data.purchaseOrderNumber !== undefined) updates.purchaseOrderNumber = data.purchaseOrderNumber;
  if (data.invoiceDate) updates.invoiceDate = new Date(data.invoiceDate);
  if (data.notes !== undefined) updates.notes = data.notes;

  if (data.supplierId) {
    const supplier = await getSupplierById(data.supplierId);
    if (!supplier) throw createStatusError('Supplier not found', 404);
    updates.supplier = supplier._id;
    if (!data.paymentTerms) {
      updates.paymentTerms = supplier.paymentTerms;
    }
    if (!Number.isFinite(data.creditDays)) {
      updates.creditDays = supplier.creditDays || 0;
    }
  }

  if (data.paymentTerms) updates.paymentTerms = data.paymentTerms;
  if (Number.isFinite(data.creditDays)) updates.creditDays = normalizeNumber(data.creditDays, 0);
  if (data.dueDate) updates.dueDate = new Date(data.dueDate);

  if (data.items?.length) {
    const normalizedItems = await normalizePurchaseItems(data.items);
    const totals = computePurchaseTotals(normalizedItems);
    if ((purchase.paidAmount || 0) > totals.grandTotal) {
      throw createStatusError('Updated total cannot be less than paid amount');
    }
    updates.items = totals.items;
    updates.subTotal = totals.subTotal;
    updates.discountTotal = totals.discountTotal;
    updates.taxTotal = totals.taxTotal;
    updates.grandTotal = totals.grandTotal;

    const payment = computePaymentStatus(totals.grandTotal, purchase.paidAmount || 0);
    updates.paymentStatus = payment.paymentStatus;
    updates.dueAmount = payment.dueAmount;
  }

  if (updates.paymentTerms || updates.creditDays || updates.invoiceDate) {
    updates.dueDate = resolveDueDate({
      paymentTerms: (updates.paymentTerms as string) || purchase.paymentTerms,
      creditDays: (updates.creditDays as number) ?? purchase.creditDays,
      dueDate: (updates.dueDate as Date | string | undefined) || purchase.dueDate,
      invoiceDate: (updates.invoiceDate as Date) || purchase.invoiceDate,
    });
  }

  updates.updatedBy = actorId;

  return purchaseOrderRepository.update(purchaseId, updates) as Promise<IPurchaseOrder>;
}
