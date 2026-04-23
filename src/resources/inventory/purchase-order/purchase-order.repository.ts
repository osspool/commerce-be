import { Repository, requireField, validationChainPlugin } from '@classytic/mongokit';
import type { ClientSession } from 'mongoose';
import type { IPurchaseOrder, IStatusHistory } from './models/purchase-order.model.js';
import PurchaseOrder from './models/purchase-order.model.js';

class PurchaseOrderRepository extends Repository<IPurchaseOrder> {
  constructor() {
    super(
      PurchaseOrder,
      [validationChainPlugin([requireField('invoiceNumber', ['create']), requireField('branch', ['create'])])],
      {
        defaultLimit: 20,
        maxLimit: 100,
      },
    );
  }

  async appendStatus(
    id: string,
    statusEntry: IStatusHistory,
    updates: Record<string, unknown> = {},
    options: { session?: ClientSession | null } = {},
  ): Promise<IPurchaseOrder | null> {
    const { session = null } = options;
    return this.Model.findByIdAndUpdate(
      id,
      {
        ...updates,
        $push: { statusHistory: statusEntry },
      },
      { returnDocument: 'after', ...(session ? { session } : {}) },
    ).lean();
  }

  async recordPayment(
    id: string,
    transactionId: string,
    paymentUpdate: Record<string, unknown> = {},
    options: { session?: ClientSession | null } = {},
  ): Promise<IPurchaseOrder | null> {
    const { session = null } = options;
    return this.Model.findByIdAndUpdate(
      id,
      {
        $push: { transactionIds: transactionId },
        ...paymentUpdate,
      },
      { returnDocument: 'after', ...(session ? { session } : {}) },
    ).lean();
  }
}

export default new PurchaseOrderRepository();
