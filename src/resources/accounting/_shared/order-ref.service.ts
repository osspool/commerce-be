/**
 * OrderRef service — typed lookup of `referenceNumber` + `customerId` by
 * order `_id`, used by COD posting handlers (cod-settled, cod-cancelled)
 * to thread the customer reference through the A/R subsidiary ledger.
 *
 * Routes through the order kernel's mongokit Repository.getById so soft-
 * delete / cache / hook plugins fire — never via `db.collection('orders')`
 * raw mongo access. The handlers don't import the order package directly
 * (they're in the accounting domain); this shared service is the bridge.
 */

import { ensureOrderEngine } from '../../sales/orders/order.engine.js';

export interface OrderRefAndCustomer {
  referenceNumber?: string;
  customerId?: string | null;
}

export async function getOrderRefAndCustomer(orderId: string): Promise<OrderRefAndCustomer> {
  if (!orderId) return {};
  const engine = await ensureOrderEngine();
  const orderRepo = engine.repositories.order as unknown as {
    getById: (
      id: string,
      options: { select?: string; lean?: boolean; throwOnNotFound?: boolean },
    ) => Promise<{ referenceNumber?: unknown; customerId?: unknown } | null>;
  };
  const doc = await orderRepo.getById(orderId, {
    select: 'referenceNumber customerId',
    lean: true,
    throwOnNotFound: false,
  });
  if (!doc) return {};
  return {
    referenceNumber: typeof doc.referenceNumber === 'string' ? doc.referenceNumber : undefined,
    customerId: doc.customerId ? String(doc.customerId) : null,
  };
}

export async function getOrderReferenceNumber(orderId: string): Promise<string | undefined> {
  const { referenceNumber } = await getOrderRefAndCustomer(orderId);
  return referenceNumber;
}
