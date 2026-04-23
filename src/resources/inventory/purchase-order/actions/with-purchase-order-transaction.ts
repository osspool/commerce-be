import { withTransaction as mongokitWithTransaction } from '@classytic/mongokit';
import type { ClientSession } from 'mongoose';
import logger from '#lib/utils/logger.js';
import purchaseOrderRepository from '../purchase-order.repository.js';

export async function withPurchaseTransaction<T>(
  operation: (session: ClientSession | null) => Promise<T>,
  options: { onCommit?: (result: T) => Promise<void> } = {},
): Promise<T> {
  const { onCommit } = options;
  const result = await mongokitWithTransaction(
    purchaseOrderRepository.Model.db,
    (session) => operation(session as ClientSession | null),
    {
      allowFallback: true,
      onFallback: (error: Error) => {
        logger.warn({ err: error }, 'Transactions not supported; falling back to non-transactional purchase flow');
      },
    },
  );

  if (onCommit) {
    await onCommit(result);
  }

  return result;
}
