import type { PurchaseOrderDocument } from '@classytic/purchase';
import { createStatusError } from '#resources/inventory/shared/status-errors.js';
import { getPurchaseEngine } from '#resources/inventory/_engines/purchase.engine.js';
import purchaseOrderRepository from '../purchase-order.repository.js';
import type { PurchaseWithId } from './shared.js';

/**
 * Approve a draft purchase.
 *
 * Uses the engine's `repositories.purchaseOrder.approve()` CAS verb (from
 * `@classytic/purchase`) instead of the legacy local `appendStatus` $set
 * helper — the package transitions `draft → approved` atomically via
 * mongokit's `claim()`, so a concurrent cancel cannot race past the FSM.
 *
 * The friendly-error read happens before the CAS so callers see a precise
 * message ("Only draft purchases can be approved") instead of a generic
 * "concurrent modification" from the package layer.
 */
export async function approvePurchase(
  purchaseId: string,
  actorId: string | undefined,
  assertState: (action: string, currentState: string, errorFactory: typeof createStatusError, message: string) => void,
): Promise<PurchaseOrderDocument> {
  const purchase = (await purchaseOrderRepository.getById(purchaseId, { lean: true })) as PurchaseWithId | null;
  if (!purchase) throw createStatusError('Purchase not found', 404);
  assertState('approve', purchase.status, createStatusError, 'Only draft purchases can be approved');

  return getPurchaseEngine().repositories.purchaseOrder.approve(
    purchaseId,
    actorId ? { actorId } : {},
  );
}
