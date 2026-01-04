import createError from 'http-errors';
import { Repository, validationChainPlugin } from '@classytic/mongokit';
import Transaction from './transaction.model.js';
import { TRANSACTION_STATUS } from '@classytic/revenue/enums';
import { createDefaultLoader } from '#core/utils/lazy-import.js';
import {
  validateTransactionUpdateData,
  blockTransactionDelete,
} from './validators/transaction.validators.js';

const loadArchiveRepository = createDefaultLoader('#modules/archive/archive.repository.js');

/**
 * Transaction Repository
 * 
 * For ecommerce:
 * - All transactions created via revenue library (no manual creation)
 * - Read-only for admin (view/reports)
 * - Updates limited to notes only
 * - Deletion blocked (immutable for accounting)
 */
class TransactionRepository extends Repository {
  constructor() {
    super(Transaction, [
      validationChainPlugin([
        validateTransactionUpdateData(),
        blockTransactionDelete(),
      ]),
    ]);
  }

  /**
   * Get transaction with populated source (Order)
   */
  async getTransactionWithSource(transactionId, options = {}) {
    const transaction = await this._executeQuery(async (Model) => {
      return Model.findById(transactionId)
        .populate({
          path: 'sourceId',
          select: options.sourceSelect || 'status customer totalAmount currentPayment',
        })
        .lean(options.lean !== false)
        .session(options.session)
        .exec();
    });

    if (!transaction) throw createError(404, 'Transaction not found');
    return transaction;
  }

  /**
   * Get all transactions for a source (e.g., all transactions for an Order)
   */
  async getTransactionsBySource(sourceModel, sourceId, options = {}) {
    return this.getAll({
      filters: { sourceModel, sourceId },
      sort: { createdAt: -1 }
    }, options);
  }

  /**
   * Check if transaction can be verified
   */
  async canVerifyTransaction(transactionId, session) {
    const transaction = await this.getById(transactionId, {
      lean: true,
      select: 'status',
      session
    });

    if (!transaction) throw createError(404, 'Transaction not found');

    return transaction.status === TRANSACTION_STATUS.PENDING;
  }

  /**
   * Check if transaction can be refunded
   */
  async canRefundTransaction(transactionId, session) {
    const transaction = await this.getById(transactionId, {
      lean: true,
      select: 'status',
      session
    });

    if (!transaction) throw createError(404, 'Transaction not found');
    return transaction.status === TRANSACTION_STATUS.VERIFIED;
  }

  /**
   * Archive old transactions to reduce database size
   * Keeps recent transactions in hot storage for quick access
   *
   * IMPORTANT: Only archives completed/verified transactions older than specified period
   * Pending/failed transactions are kept for reconciliation
   *
   * @param {Object} options - Archive options
   * @param {number} options.olderThanDays - Archive transactions older than X days (default: 365)
   * @param {string} options.branchId - Optional branch filter
   * @param {number} options.ttlDays - How long to keep archives (default: 2555 = 7 years for tax/legal compliance)
   * @returns {Promise<Object>} Archive result with count and file info
   */
  async archiveOldTransactions(options = {}) {
    const { olderThanDays = 365, branchId = null, ttlDays = 2555 } = options;

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    const match = {
      createdAt: { $lt: cutoffDate },
      status: { $in: ['completed', 'verified', 'refunded'] }, // Only archive finalized transactions
    };

    if (branchId) {
      match.branch = branchId;
    }

    // Count records to be archived
    const count = await this.Model.countDocuments(match);

    if (count === 0) {
      return { archived: 0, message: 'No old transactions to archive' };
    }

    // Use archive repository
    const archiveRepository = await loadArchiveRepository();

    const archiveResult = await archiveRepository.runArchive({
      type: 'transaction',
      organizationId: branchId || 'all',
      rangeFrom: new Date(0),
      rangeTo: cutoffDate,
      ttlDays,
    });

    return {
      archived: archiveResult.recordCount,
      filePath: archiveResult.filePath,
      cutoffDate,
      olderThanDays,
    };
  }

  /**
   * Get transaction statistics for monitoring
   *
   * @returns {Promise<Object>} Transaction stats
   */
  async getTransactionStats() {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

    const [total, last30Days, last90Days, lastYear, pending] = await Promise.all([
      this.Model.countDocuments(),
      this.Model.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
      this.Model.countDocuments({ createdAt: { $gte: ninetyDaysAgo } }),
      this.Model.countDocuments({ createdAt: { $gte: oneYearAgo } }),
      this.Model.countDocuments({ status: 'pending' }),
    ]);

    const olderThanYear = total - lastYear;
    const archivable = await this.Model.countDocuments({
      createdAt: { $lt: oneYearAgo },
      status: { $in: ['completed', 'verified', 'refunded'] },
    });

    return {
      total,
      last30Days,
      last90Days,
      lastYear,
      olderThanYear,
      pending,
      archivable,
      recommendation: archivable > 10000
        ? `Consider archiving ${archivable} finalized transactions older than 1 year`
        : 'No archiving needed yet',
    };
  }
}

const transactionRepository = new TransactionRepository();
export default transactionRepository;
