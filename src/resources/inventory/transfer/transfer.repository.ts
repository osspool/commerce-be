import { Repository, validationChainPlugin, requireField } from '@classytic/mongokit';
import Transfer, { TransferStatus } from './models/transfer.model.js';
import type { ITransfer } from './models/transfer.model.js';

/**
 * Transfer Repository
 *
 * Data access layer for stock transfers/transfers.
 * Provides query methods and validation.
 */
class TransferRepository extends Repository<ITransfer> {
  constructor() {
    super(
      Transfer,
      [
        validationChainPlugin([
          requireField('senderBranch', ['create']),
          requireField('receiverBranch', ['create']),
          requireField('items', ['create']),
          requireField('createdBy', ['create']),
        ]),
      ],
      {
        defaultLimit: 20,
        maxLimit: 100,
      },
    );
  }

  /**
   * Get transfers pending receipt at a branch
   */
  async getPendingReceipt(branchId: string): Promise<ITransfer[]> {
    return this.Model.find({
      receiverBranch: branchId,
      status: { $in: [TransferStatus.DISPATCHED, TransferStatus.IN_TRANSIT] },
    })
      .populate('senderBranch', 'code name')
      .sort({ dispatchedAt: 1 })
      .lean();
  }

  /**
   * Get transfers pending dispatch from a branch
   */
  async getPendingDispatch(branchId: string): Promise<ITransfer[]> {
    return this.Model.find({
      senderBranch: branchId,
      status: TransferStatus.APPROVED,
    })
      .populate('receiverBranch', 'code name')
      .sort({ approvedAt: 1 })
      .lean();
  }

  /**
   * Get recent transfers for a branch (as sender or receiver)
   */
  async getRecentByBranch(branchId: string, limit: number = 10): Promise<ITransfer[]> {
    return this.Model.find({
      $or: [{ senderBranch: branchId }, { receiverBranch: branchId }],
    })
      .populate('senderBranch', 'code name')
      .populate('receiverBranch', 'code name')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
  }

  /**
   * Get transfers by status
   */
  async getByStatus(
    status: string | string[],
    options: { page?: number; limit?: number } = {},
  ): Promise<{ docs: ITransfer[]; total: number; page: number; limit: number }> {
    const query = {
      status: Array.isArray(status) ? { $in: status } : status,
    };

    const { page = 1, limit = 20 } = options;
    const skip = (page - 1) * limit;

    const [docs, total] = await Promise.all([
      this.Model.find(query)
        .populate('senderBranch', 'code name')
        .populate('receiverBranch', 'code name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean() as Promise<ITransfer[]>,
      this.Model.countDocuments(query),
    ]);

    return { docs, total, page, limit };
  }

  /**
   * Count transfers by status
   */
  async countByStatus(): Promise<Record<string, number>> {
    const results = await this.Model.aggregate<{ _id: string; count: number }>([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    return results.reduce<Record<string, number>>((acc, r) => {
      acc[r._id] = r.count;
      return acc;
    }, {});
  }

  /**
   * Check if document number exists
   */
  async documentNumberExists(documentNumber: string): Promise<boolean> {
    const count = await this.Model.countDocuments({ documentNumber });
    return count > 0;
  }
}

export default new TransferRepository();
