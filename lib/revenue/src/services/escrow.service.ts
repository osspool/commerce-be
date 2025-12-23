/**
 * Escrow Service
 * @classytic/revenue
 *
 * Platform-as-intermediary payment flow
 * Hold funds → Verify → Split/Deduct → Release to organization
 */

import { TransactionNotFoundError } from '../core/errors.js';
import { HOLD_STATUS, RELEASE_REASON, HOLD_REASON } from '../enums/escrow.enums.js';
import { TRANSACTION_TYPE, TRANSACTION_STATUS } from '../enums/transaction.enums.js';
import { SPLIT_STATUS } from '../enums/split.enums.js';
import { triggerHook } from '../utils/hooks.js';
import { calculateSplits, calculateOrganizationPayout } from '../utils/commission-split.js';
import type { Container } from '../core/container.js';
import type {
  ModelsRegistry,
  HooksRegistry,
  Logger,
  TransactionDocument,
  HoldOptions,
  ReleaseOptions,
  ReleaseResult,
  CancelHoldOptions,
  SplitResult,
  EscrowStatusResult,
  SplitRule,
  SplitInfo,
} from '../types/index.js';

export class EscrowService {
  private readonly models: ModelsRegistry;
  private readonly hooks: HooksRegistry;
  private readonly logger: Logger;

  constructor(container: Container) {
    this.models = container.get<ModelsRegistry>('models');
    this.hooks = container.get<HooksRegistry>('hooks');
    this.logger = container.get<Logger>('logger');
  }

  /**
   * Hold funds in escrow
   *
   * @param transactionId - Transaction to hold
   * @param options - Hold options
   * @returns Updated transaction
   */
  async hold(
    transactionId: string,
    options: HoldOptions = {}
  ): Promise<TransactionDocument> {
    const {
      reason = HOLD_REASON.PAYMENT_VERIFICATION,
      holdUntil = null,
      metadata = {},
    } = options;

    const TransactionModel = this.models.Transaction;
    const transaction = await TransactionModel.findById(transactionId) as TransactionDocument | null;

    if (!transaction) {
      throw new TransactionNotFoundError(transactionId);
    }

    if (transaction.status !== TRANSACTION_STATUS.VERIFIED) {
      throw new Error(`Cannot hold transaction with status: ${transaction.status}. Must be verified.`);
    }

    transaction.hold = {
      status: HOLD_STATUS.HELD,
      heldAmount: transaction.amount,
      releasedAmount: 0,
      reason,
      heldAt: new Date(),
      ...(holdUntil && { holdUntil }),
      releases: [],
      metadata,
    };

    await transaction.save();

    this._triggerHook('escrow.held', {
      transaction,
      heldAmount: transaction.amount,
      reason,
    });

    return transaction;
  }

  /**
   * Release funds from escrow to recipient
   *
   * @param transactionId - Transaction to release
   * @param options - Release options
   * @returns { transaction, releaseTransaction }
   */
  async release(
    transactionId: string,
    options: ReleaseOptions
  ): Promise<ReleaseResult> {
    const {
      amount = null,
      recipientId,
      recipientType = 'organization',
      reason = RELEASE_REASON.PAYMENT_VERIFIED,
      releasedBy = null,
      createTransaction = true,
      metadata = {},
    } = options;

    const TransactionModel = this.models.Transaction;
    const transaction = await TransactionModel.findById(transactionId) as TransactionDocument | null;

    if (!transaction) {
      throw new TransactionNotFoundError(transactionId);
    }

    if (!transaction.hold || transaction.hold.status !== HOLD_STATUS.HELD) {
      throw new Error(`Transaction is not in held status. Current: ${transaction.hold?.status ?? 'none'}`);
    }

    if (!recipientId) {
      throw new Error('recipientId is required for release');
    }

    const releaseAmount = amount ?? (transaction.hold.heldAmount - transaction.hold.releasedAmount);
    const availableAmount = transaction.hold.heldAmount - transaction.hold.releasedAmount;

    if (releaseAmount > availableAmount) {
      throw new Error(`Release amount (${releaseAmount}) exceeds available held amount (${availableAmount})`);
    }

    const releaseRecord = {
      amount: releaseAmount,
      recipientId,
      recipientType,
      releasedAt: new Date(),
      releasedBy,
      reason,
      metadata,
    };

    transaction.hold.releases.push(releaseRecord);
    transaction.hold.releasedAmount += releaseAmount;

    const isFullRelease = transaction.hold.releasedAmount >= transaction.hold.heldAmount;
    const isPartialRelease = transaction.hold.releasedAmount > 0 && transaction.hold.releasedAmount < transaction.hold.heldAmount;

    if (isFullRelease) {
      transaction.hold.status = HOLD_STATUS.RELEASED;
      transaction.hold.releasedAt = new Date();
      transaction.status = TRANSACTION_STATUS.COMPLETED;
    } else if (isPartialRelease) {
      transaction.hold.status = HOLD_STATUS.PARTIALLY_RELEASED;
    }

    await transaction.save();

    let releaseTransaction: TransactionDocument | null = null;
    if (createTransaction) {
      releaseTransaction = await TransactionModel.create({
        organizationId: transaction.organizationId,
        customerId: recipientId,
        amount: releaseAmount,
        currency: transaction.currency,
        category: transaction.category,
        type: TRANSACTION_TYPE.INCOME,
        method: transaction.method,
        status: TRANSACTION_STATUS.COMPLETED,
        gateway: transaction.gateway,
        referenceId: transaction.referenceId,
        referenceModel: transaction.referenceModel,
        metadata: {
          ...metadata,
          isRelease: true,
          heldTransactionId: transaction._id.toString(),
          releaseReason: reason,
          recipientType,
        },
        idempotencyKey: `release_${transaction._id}_${Date.now()}`,
      }) as TransactionDocument;
    }

    this._triggerHook('escrow.released', {
      transaction,
      releaseTransaction,
      releaseAmount,
      recipientId,
      recipientType,
      reason,
      isFullRelease,
      isPartialRelease,
    });

    return {
      transaction,
      releaseTransaction,
      releaseAmount,
      isFullRelease,
      isPartialRelease,
    };
  }

  /**
   * Cancel hold and release back to customer
   *
   * @param transactionId - Transaction to cancel hold
   * @param options - Cancel options
   * @returns Updated transaction
   */
  async cancel(
    transactionId: string,
    options: CancelHoldOptions = {}
  ): Promise<TransactionDocument> {
    const { reason = 'Hold cancelled', metadata = {} } = options;

    const TransactionModel = this.models.Transaction;
    const transaction = await TransactionModel.findById(transactionId) as TransactionDocument | null;

    if (!transaction) {
      throw new TransactionNotFoundError(transactionId);
    }

    if (!transaction.hold || transaction.hold.status !== HOLD_STATUS.HELD) {
      throw new Error(`Transaction is not in held status. Current: ${transaction.hold?.status ?? 'none'}`);
    }

    transaction.hold.status = HOLD_STATUS.CANCELLED;
    transaction.hold.cancelledAt = new Date();
    transaction.hold.metadata = {
      ...transaction.hold.metadata,
      ...metadata,
      cancelReason: reason,
    };

    transaction.status = TRANSACTION_STATUS.CANCELLED;

    await transaction.save();

    this._triggerHook('escrow.cancelled', {
      transaction,
      reason,
    });

    return transaction;
  }

  /**
   * Split payment to multiple recipients
   * Deducts splits from held amount and releases remainder to organization
   *
   * @param transactionId - Transaction to split
   * @param splitRules - Split configuration
   * @returns { transaction, splitTransactions, organizationTransaction }
   */
  async split(
    transactionId: string,
    splitRules: SplitRule[] = []
  ): Promise<SplitResult> {
    const TransactionModel = this.models.Transaction;
    const transaction = await TransactionModel.findById(transactionId) as TransactionDocument | null;

    if (!transaction) {
      throw new TransactionNotFoundError(transactionId);
    }

    if (!transaction.hold || transaction.hold.status !== HOLD_STATUS.HELD) {
      throw new Error(`Transaction must be held before splitting. Current: ${transaction.hold?.status ?? 'none'}`);
    }

    if (!splitRules || splitRules.length === 0) {
      throw new Error('splitRules cannot be empty');
    }

    const splits = calculateSplits(
      transaction.amount,
      splitRules,
      transaction.commission?.gatewayFeeRate ?? 0
    );

    transaction.splits = splits;
    await transaction.save();

    const splitTransactions: TransactionDocument[] = [];

    for (const split of splits) {
      const splitTransaction = await TransactionModel.create({
        organizationId: transaction.organizationId,
        customerId: split.recipientId,
        amount: split.netAmount,
        currency: transaction.currency,
        category: split.type,
        type: TRANSACTION_TYPE.EXPENSE,
        method: transaction.method,
        status: TRANSACTION_STATUS.COMPLETED,
        gateway: transaction.gateway,
        referenceId: transaction.referenceId,
        referenceModel: transaction.referenceModel,
        metadata: {
          isSplit: true,
          splitType: split.type,
          recipientType: split.recipientType,
          originalTransactionId: transaction._id.toString(),
          grossAmount: split.grossAmount,
          gatewayFeeAmount: split.gatewayFeeAmount,
        },
        idempotencyKey: `split_${transaction._id}_${split.recipientId}_${Date.now()}`,
      }) as TransactionDocument;

      (split as SplitInfo & { payoutTransactionId?: string }).payoutTransactionId = splitTransaction._id.toString();
      split.status = SPLIT_STATUS.PAID;
      (split as SplitInfo & { paidDate?: Date }).paidDate = new Date();

      splitTransactions.push(splitTransaction);
    }

    await transaction.save();

    const organizationPayout = calculateOrganizationPayout(transaction.amount, splits);

    const organizationTransaction = await this.release(transactionId, {
      amount: organizationPayout,
      recipientId: transaction.organizationId?.toString() ?? '',
      recipientType: 'organization',
      reason: RELEASE_REASON.PAYMENT_VERIFIED,
      createTransaction: true,
      metadata: {
        afterSplits: true,
        totalSplits: splits.length,
        totalSplitAmount: transaction.amount - organizationPayout,
      },
    });

    this._triggerHook('escrow.split', {
      transaction,
      splits,
      splitTransactions,
      organizationTransaction: organizationTransaction.releaseTransaction,
      organizationPayout,
    });

    return {
      transaction,
      splits,
      splitTransactions,
      organizationTransaction: organizationTransaction.releaseTransaction,
      organizationPayout,
    };
  }

  /**
   * Get escrow status
   *
   * @param transactionId - Transaction ID
   * @returns Escrow status
   */
  async getStatus(transactionId: string): Promise<EscrowStatusResult> {
    const TransactionModel = this.models.Transaction;
    const transaction = await TransactionModel.findById(transactionId) as TransactionDocument | null;

    if (!transaction) {
      throw new TransactionNotFoundError(transactionId);
    }

    return {
      transaction,
      hold: transaction.hold ?? null,
      splits: transaction.splits ?? [],
      hasHold: !!transaction.hold,
      hasSplits: transaction.splits ? transaction.splits.length > 0 : false,
    };
  }

  private _triggerHook(event: string, data: unknown): void {
    triggerHook(this.hooks, event, data, this.logger);
  }
}

export default EscrowService;

