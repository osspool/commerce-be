import createError from 'http-errors';
import { Repository, validationChainPlugin } from '@classytic/mongokit';
import type { ClientSession } from 'mongoose';
import Transaction from './transaction.model.js';
import type { ITransaction } from './transaction.model.js';
import { TRANSACTION_STATUS } from '@classytic/revenue/enums';
import { createDefaultLoader } from '#lib/utils/lazy-import.js';
import { validateTransactionUpdateData, blockTransactionDelete } from './validators/transaction.validators.js';

const loadArchiveRepository = createDefaultLoader('#resources/archive/archive.repository.js');

interface GetTransactionOptions {
  sourceSelect?: string;
  lean?: boolean;
  session?: ClientSession | null;
}

interface ArchiveOptions {
  olderThanDays?: number;
  branchId?: string | null;
  ttlDays?: number;
}

/**
 * Transaction Repository
 *
 * For ecommerce:
 * - All transactions created via revenue library (no manual creation)
 * - Read-only for admin (view/reports)
 * - Updates limited to notes only
 * - Deletion blocked (immutable for accounting)
 */
class TransactionRepository extends Repository<ITransaction> {
  constructor() {
    super(Transaction, [validationChainPlugin([validateTransactionUpdateData() as any, blockTransactionDelete()])]);
  }

  /**
   * Get transaction with populated source (Order)
   */
  async getTransactionWithSource(transactionId: string, options: GetTransactionOptions = {}) {
    const transaction = await this._executeQuery(async (Model: typeof Transaction) => {
      return Model.findById(transactionId)
        .populate({
          path: 'sourceId',
          select: options.sourceSelect || 'status customer totalAmount currentPayment',
        })
        .lean(options.lean !== false)
        .session(options.session ?? null)
        .exec();
    });

    if (!transaction) throw createError(404, 'Transaction not found');
    return transaction;
  }

  /**
   * Get all transactions for a source (e.g., all transactions for an Order)
   */
  async getTransactionsBySource(sourceModel: string, sourceId: string, options: Record<string, unknown> = {}) {
    return this.getAll(
      {
        filters: { sourceModel, sourceId },
        sort: { createdAt: -1 },
      },
      options,
    );
  }

  /**
   * Check if transaction can be verified
   */
  async canVerifyTransaction(transactionId: string, session?: ClientSession | null): Promise<boolean> {
    const transaction = await this.getById(transactionId, {
      lean: true,
      select: 'status',
      session: session ?? undefined,
    });

    if (!transaction) throw createError(404, 'Transaction not found');

    return transaction.status === TRANSACTION_STATUS.PENDING;
  }

  /**
   * Check if transaction can be refunded
   */
  async canRefundTransaction(transactionId: string, session?: ClientSession | null): Promise<boolean> {
    const transaction = await this.getById(transactionId, {
      lean: true,
      select: 'status',
      session: session ?? undefined,
    });

    if (!transaction) throw createError(404, 'Transaction not found');
    return transaction.status === TRANSACTION_STATUS.VERIFIED;
  }

  /**
   * Archive old transactions to reduce database size
   */
  async archiveOldTransactions(options: ArchiveOptions = {}) {
    const { olderThanDays = 365, branchId = null, ttlDays = 2555 } = options;

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    const match: Record<string, unknown> = {
      createdAt: { $lt: cutoffDate },
      status: { $in: ['completed', 'verified', 'refunded'] },
    };

    if (branchId) {
      match.branch = branchId;
    }

    const count = await this.Model.countDocuments(match);

    if (count === 0) {
      return { archived: 0, message: 'No old transactions to archive' };
    }

    const archiveRepository = (await loadArchiveRepository()) as {
      runArchive: (params: Record<string, unknown>) => Promise<{ recordCount: number; filePath: string }>;
    };

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
      recommendation:
        archivable > 10000
          ? `Consider archiving ${archivable} finalized transactions older than 1 year`
          : 'No archiving needed yet',
    };
  }
}

const transactionRepository = new TransactionRepository();
export default transactionRepository;
