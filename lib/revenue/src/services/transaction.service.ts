/**
 * Transaction Service
 * @classytic/revenue
 *
 * Thin, focused transaction service for core operations
 * Users handle their own analytics, exports, and complex queries
 *
 * Works with ANY model implementation:
 * - Plain Mongoose models
 * - @classytic/mongokit Repository instances
 * - Any other abstraction with compatible interface
 */

import { TransactionNotFoundError } from '../core/errors.js';
import { triggerHook } from '../utils/hooks.js';
import type { Container } from '../core/container.js';
import type {
  ModelsRegistry,
  HooksRegistry,
  Logger,
  TransactionDocument,
  TransactionListResult,
  ListOptions,
} from '../types/index.js';

/**
 * Transaction Service
 * Focused on core transaction lifecycle operations
 */
export class TransactionService {
  private readonly models: ModelsRegistry;
  private readonly hooks: HooksRegistry;
  private readonly logger: Logger;

  constructor(container: Container) {
    this.models = container.get<ModelsRegistry>('models');
    this.hooks = container.get<HooksRegistry>('hooks');
    this.logger = container.get<Logger>('logger');
  }

  /**
   * Get transaction by ID
   *
   * @param transactionId - Transaction ID
   * @returns Transaction
   */
  async get(transactionId: string): Promise<TransactionDocument> {
    const TransactionModel = this.models.Transaction;
    const transaction = await TransactionModel.findById(transactionId) as TransactionDocument | null;

    if (!transaction) {
      throw new TransactionNotFoundError(transactionId);
    }

    return transaction;
  }

  /**
   * List transactions with filters
   *
   * @param filters - Query filters
   * @param options - Query options (limit, skip, sort, populate)
   * @returns { transactions, total, page, limit }
   */
  async list(
    filters: Record<string, unknown> = {},
    options: ListOptions = {}
  ): Promise<TransactionListResult> {
    const TransactionModel = this.models.Transaction;
    const {
      limit = 50,
      skip = 0,
      page = null,
      sort = { createdAt: -1 },
      populate = [],
    } = options;

    // Calculate pagination
    const actualSkip = page ? (page - 1) * limit : skip;

    // Build query
    type QueryBuilder = {
      find(filter: object): QueryBuilder;
      limit(n: number): QueryBuilder;
      skip(n: number): QueryBuilder;
      sort(s: object): QueryBuilder;
      populate(field: string): QueryBuilder;
      then<T>(resolve: (value: TransactionDocument[]) => T): Promise<T>;
    };

    let query = (TransactionModel as unknown as {
      find(filter: object): QueryBuilder;
    }).find(filters)
      .limit(limit)
      .skip(actualSkip)
      .sort(sort);

    // Apply population if supported
    if (populate.length > 0 && typeof query.populate === 'function') {
      populate.forEach((field) => {
        query = query.populate(field);
      });
    }

    const transactions = await query as unknown as TransactionDocument[];

    // Count documents (works with both Mongoose and Repository)
    type ModelWithCount = {
      countDocuments?(filter: object): Promise<number>;
      count?(filter: object): Promise<number>;
    };

    const model = TransactionModel as unknown as ModelWithCount;
    const total = await (model.countDocuments
      ? model.countDocuments(filters)
      : model.count?.(filters)) ?? 0;

    return {
      transactions,
      total,
      page: page ?? Math.floor(actualSkip / limit) + 1,
      limit,
      pages: Math.ceil(total / limit),
    };
  }

  /**
   * Update transaction
   *
   * @param transactionId - Transaction ID
   * @param updates - Fields to update
   * @returns Updated transaction
   */
  async update(
    transactionId: string,
    updates: Partial<TransactionDocument>
  ): Promise<TransactionDocument> {
    const TransactionModel = this.models.Transaction;

    // Support both Repository pattern and Mongoose
    type ModelWithUpdate = {
      update?(id: string, data: object): Promise<TransactionDocument | null>;
      findByIdAndUpdate?(id: string, data: object, options?: object): Promise<TransactionDocument | null>;
    };

    const model = TransactionModel as unknown as ModelWithUpdate;
    let transaction: TransactionDocument | null;

    if (typeof model.update === 'function') {
      // Repository pattern
      transaction = await model.update(transactionId, updates);
    } else if (typeof model.findByIdAndUpdate === 'function') {
      // Plain Mongoose
      transaction = await model.findByIdAndUpdate(
        transactionId,
        { $set: updates },
        { new: true }
      );
    } else {
      throw new Error('Transaction model does not support update operations');
    }

    if (!transaction) {
      throw new TransactionNotFoundError(transactionId);
    }

    // Trigger hook (fire-and-forget, non-blocking)
    this._triggerHook('transaction.updated', {
      transaction,
      updates,
    });

    return transaction;
  }

  /**
   * Trigger event hook (fire-and-forget, non-blocking)
   * @private
   */
  private _triggerHook(event: string, data: unknown): void {
    triggerHook(this.hooks, event, data, this.logger);
  }
}

export default TransactionService;

