import { Repository, validationChainPlugin, requireField } from '@classytic/mongokit';
import Transfer, { TransferStatus } from './transfer.model.js';

/**
 * Transfer Repository
 *
 * Data access layer for stock transfers/challans.
 * Provides query methods and validation.
 */
class TransferRepository extends Repository {
  constructor() {
    super(Transfer, [
      validationChainPlugin([
        requireField('senderBranch', ['create']),
        requireField('receiverBranch', ['create']),
        requireField('items', ['create']),
        requireField('createdBy', ['create']),
      ]),
    ], {
      defaultLimit: 20,
      maxLimit: 100,
    });
  }

  /**
   * Get transfers pending receipt at a branch
   * @param {string} branchId - Receiver branch ID
   * @returns {Promise<Array>}
   */
  async getPendingReceipt(branchId) {
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
   * @param {string} branchId - Sender branch ID
   * @returns {Promise<Array>}
   */
  async getPendingDispatch(branchId) {
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
   * @param {string} branchId - Branch ID
   * @param {number} limit - Number of records
   * @returns {Promise<Array>}
   */
  async getRecentByBranch(branchId, limit = 10) {
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
   * @param {string|Array} status - Status or array of statuses
   * @param {Object} options - Pagination options
   * @returns {Promise<Object>}
   */
  async getByStatus(status, options = {}) {
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
        .lean(),
      this.Model.countDocuments(query),
    ]);

    return { docs, total, page, limit };
  }

  /**
   * Count transfers by status
   * @returns {Promise<Object>}
   */
  async countByStatus() {
    const results = await this.Model.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    return results.reduce((acc, r) => {
      acc[r._id] = r.count;
      return acc;
    }, {});
  }

  /**
   * Check if challan number exists
   * @param {string} challanNumber - Challan number to check
   * @returns {Promise<boolean>}
   */
  async challanNumberExists(challanNumber) {
    const count = await this.Model.countDocuments({ challanNumber });
    return count > 0;
  }
}

export default new TransferRepository();
