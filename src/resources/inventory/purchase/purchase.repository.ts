import type { ClientSession } from 'mongoose';
import { Repository, validationChainPlugin, requireField } from '@classytic/mongokit';
import Purchase from './models/purchase.model.js';
import type { IPurchase, IStatusHistory } from './models/purchase.model.js';

class PurchaseRepository extends Repository<IPurchase> {
  constructor() {
    super(
      Purchase,
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
  ): Promise<IPurchase | null> {
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
  ): Promise<IPurchase | null> {
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

export default new PurchaseRepository();
