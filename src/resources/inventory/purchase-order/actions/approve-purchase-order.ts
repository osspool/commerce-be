import { createStatusError } from '#resources/inventory/shared/status-errors.js';
import type { IPurchaseOrder, IStatusHistory } from '../models/purchase-order.model.js';
import { PurchaseOrderStatus } from '../models/purchase-order.model.js';
import purchaseOrderRepository from '../purchase-order.repository.js';
import { buildStatusEntry } from '../purchase-order.utils.js';
import type { PurchaseWithId } from './shared.js';

export async function approvePurchase(
  purchaseId: string,
  actorId: string | undefined,
  assertState: (action: string, currentState: string, errorFactory: typeof createStatusError, message: string) => void,
): Promise<IPurchaseOrder> {
  const purchase = (await purchaseOrderRepository.getById(purchaseId, { lean: true })) as PurchaseWithId | null;
  if (!purchase) throw createStatusError('Purchase not found', 404);
  assertState('approve', purchase.status, createStatusError, 'Only draft purchases can be approved');

  return purchaseOrderRepository.appendStatus(
    purchaseId,
    buildStatusEntry(PurchaseOrderStatus.APPROVED, actorId, 'Purchase approved') as unknown as IStatusHistory,
    {
      status: PurchaseOrderStatus.APPROVED,
      approvedBy: actorId,
      approvedAt: new Date(),
      updatedBy: actorId,
    },
  ) as Promise<IPurchaseOrder>;
}
