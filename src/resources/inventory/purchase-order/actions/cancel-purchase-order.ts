import { createStatusError } from '#resources/inventory/shared/status-errors.js';
import type { IPurchaseOrder, IStatusHistory } from '../models/purchase-order.model.js';
import { PurchaseOrderStatus } from '../models/purchase-order.model.js';
import purchaseOrderRepository from '../purchase-order.repository.js';
import { buildStatusEntry } from '../purchase-order.utils.js';
import type { PurchaseWithId } from './shared.js';

export async function cancelPurchase(
  purchaseId: string,
  actorId: string | undefined,
  reason: string | undefined,
  assertState: (action: string, currentState: string, errorFactory: typeof createStatusError, message: string) => void,
): Promise<IPurchaseOrder | null> {
  const purchase = (await purchaseOrderRepository.getById(purchaseId, { lean: true })) as PurchaseWithId | null;
  if (!purchase) throw createStatusError('Purchase not found', 404);
  assertState('cancel', purchase.status, createStatusError, 'Only draft or approved purchases can be cancelled');

  return purchaseOrderRepository.appendStatus(
    purchaseId,
    buildStatusEntry(PurchaseOrderStatus.CANCELLED, actorId, reason || 'Purchase cancelled') as unknown as IStatusHistory,
    {
      status: PurchaseOrderStatus.CANCELLED,
      updatedBy: actorId,
    },
  );
}
