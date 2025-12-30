import { Repository, validationChainPlugin, requireField } from '@classytic/mongokit';
import Purchase from './models/purchase.model.js';

class PurchaseRepository extends Repository {
  constructor() {
    super(Purchase, [
      validationChainPlugin([
        requireField('invoiceNumber', ['create']),
        requireField('branch', ['create']),
      ]),
    ], {
      defaultLimit: 20,
      maxLimit: 100,
    });
  }

  async appendStatus(id, statusEntry, updates = {}, options = {}) {
    const { session = null } = options;
    return this.Model.findByIdAndUpdate(
      id,
      {
        ...updates,
        $push: { statusHistory: statusEntry },
      },
      { new: true, ...(session ? { session } : {}) }
    ).lean();
  }

  async recordPayment(id, transactionId, paymentUpdate = {}, options = {}) {
    const { session = null } = options;
    return this.Model.findByIdAndUpdate(
      id,
      {
        $push: { transactionIds: transactionId },
        ...paymentUpdate,
      },
      { new: true, ...(session ? { session } : {}) }
    ).lean();
  }
}

export default new PurchaseRepository();
