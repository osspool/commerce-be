import type { PurchaseOrderDocument } from '@classytic/purchase';
import { createStatusError } from '#resources/inventory/shared/status-errors.js';
import { getPurchaseEngine } from '#resources/inventory/_engines/purchase.engine.js';
import purchaseOrderRepository from '../purchase-order.repository.js';
import type { PurchaseWithId } from './shared.js';

/**
 * Cancel a draft or approved purchase.
 *
 * Uses the engine's `repositories.purchaseOrder.cancel()` CAS verb instead
 * of the legacy `appendStatus` $set helper — `[draft|approved] → cancelled`
 * is a single atomic claim, so a concurrent payment / approval / receive
 * cannot race past the FSM gate.
 */
export async function cancelPurchase(
  purchaseId: string,
  actorId: string | undefined,
  reason: string | undefined,
  assertState: (action: string, currentState: string, errorFactory: typeof createStatusError, message: string) => void,
): Promise<PurchaseOrderDocument> {
  const purchase = (await purchaseOrderRepository.getById(purchaseId, { lean: true })) as PurchaseWithId | null;
  if (!purchase) throw createStatusError('Purchase not found', 404);
  assertState('cancel', purchase.status, createStatusError, 'Only draft or approved purchases can be cancelled');

  return getPurchaseEngine().repositories.purchaseOrder.cancel(
    purchaseId,
    reason,
    actorId ? { actorId } : {},
  );
}
