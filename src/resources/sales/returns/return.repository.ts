import { customIdPlugin, dateSequentialId, Repository, requireField, validationChainPlugin } from '@classytic/mongokit';
import type { IReturn } from './models/return.model.js';
import Return from './models/return.model.js';

class ReturnRepository extends Repository<IReturn> {
  constructor() {
    super(
      Return,
      [
        customIdPlugin({
          field: 'returnNumber',
          generator: dateSequentialId({
            prefix: 'RET',
            model: Return,
            partition: 'monthly',
            padding: 4,
          }),
        }),
        validationChainPlugin([
          requireField('orderId', ['create']),
          requireField('items', ['create']),
          requireField('createdBy', ['create']),
        ]),
      ],
      { defaultLimit: 20, maxLimit: 100 },
    );
  }

  async getByOrder(orderId: string): Promise<IReturn[]> {
    return this.Model.find({ orderId }).sort({ createdAt: -1 }).lean() as unknown as Promise<IReturn[]>;
  }

  async getPendingInspection(branchId: string): Promise<IReturn[]> {
    return this.Model.find({ branch: branchId, status: 'received' })
      .sort({ createdAt: 1 })
      .lean() as unknown as Promise<IReturn[]>;
  }
}

export default new ReturnRepository();
