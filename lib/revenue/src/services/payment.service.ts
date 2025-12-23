/**
 * Payment Service
 * @classytic/revenue
 *
 * Framework-agnostic payment verification and management service with DI
 * Handles payment verification, refunds, and status updates
 */

import {
  TransactionNotFoundError,
  ProviderNotFoundError,
  ProviderError,
  AlreadyVerifiedError,
  PaymentVerificationError,
  RefundNotSupportedError,
  RefundError,
  ProviderCapabilityError,
  ValidationError,
} from '../core/errors.js';
import { triggerHook } from '../utils/hooks.js';
import { reverseCommission } from '../utils/commission.js';
import { TRANSACTION_TYPE } from '../enums/transaction.enums.js';
import type { Container } from '../core/container.js';
import type {
  ModelsRegistry,
  ProvidersRegistry,
  HooksRegistry,
  RevenueConfig,
  Logger,
  TransactionDocument,
  PaymentVerifyOptions,
  PaymentVerifyResult,
  PaymentStatusResult,
  RefundOptions,
  PaymentRefundResult,
  WebhookResult,
  ListOptions,
  PaymentResultData,
  PaymentProviderInterface,
  TransactionTypeValue,
  MongooseModel,
} from '../types/index.js';

/**
 * Payment Service
 * Uses DI container for all dependencies
 */
export class PaymentService {
  private readonly models: ModelsRegistry;
  private readonly providers: ProvidersRegistry;
  private readonly config: RevenueConfig;
  private readonly hooks: HooksRegistry;
  private readonly logger: Logger;

  constructor(container: Container) {
    this.models = container.get<ModelsRegistry>('models');
    this.providers = container.get<ProvidersRegistry>('providers');
    this.config = container.get<RevenueConfig>('config');
    this.hooks = container.get<HooksRegistry>('hooks');
    this.logger = container.get<Logger>('logger');
  }

  /**
   * Verify a payment
   *
   * @param paymentIntentId - Payment intent ID, session ID, or transaction ID
   * @param options - Verification options
   * @returns { transaction, status }
   */
  async verify(
    paymentIntentId: string,
    options: PaymentVerifyOptions = {}
  ): Promise<PaymentVerifyResult> {
    const { verifiedBy = null } = options;

    const TransactionModel = this.models.Transaction;
    const transaction = await this._findTransaction(TransactionModel, paymentIntentId);

    if (!transaction) {
      throw new TransactionNotFoundError(paymentIntentId);
    }

    if (transaction.status === 'verified' || transaction.status === 'completed') {
      throw new AlreadyVerifiedError(transaction._id.toString());
    }

    // Get provider for verification
    const gatewayType = transaction.gateway?.type ?? 'manual';
    const provider = this.providers[gatewayType];

    if (!provider) {
      throw new ProviderNotFoundError(gatewayType, Object.keys(this.providers));
    }

    // Verify payment with provider
    let paymentResult: PaymentResultData | null = null;
    try {
      paymentResult = await provider.verifyPayment(paymentIntentId);
    } catch (error) {
      this.logger.error('Payment verification failed:', error);

      // Update transaction as failed
      transaction.status = 'failed';
      transaction.failureReason = (error as Error).message;
      transaction.metadata = {
        ...transaction.metadata,
        verificationError: (error as Error).message,
        failedAt: new Date().toISOString(),
      };
      await transaction.save();

      // Trigger payment.failed hook
      this._triggerHook('payment.failed', {
        transaction,
        error: (error as Error).message,
        provider: gatewayType,
        paymentIntentId,
      });

      throw new PaymentVerificationError(paymentIntentId, (error as Error).message);
    }

    // Validate amount and currency match
    if (paymentResult.amount && paymentResult.amount !== transaction.amount) {
      throw new ValidationError(
        `Amount mismatch: expected ${transaction.amount}, got ${paymentResult.amount}`,
        { expected: transaction.amount, actual: paymentResult.amount }
      );
    }

    if (paymentResult.currency && paymentResult.currency.toUpperCase() !== transaction.currency.toUpperCase()) {
      throw new ValidationError(
        `Currency mismatch: expected ${transaction.currency}, got ${paymentResult.currency}`,
        { expected: transaction.currency, actual: paymentResult.currency }
      );
    }

    // Update transaction based on verification result
    transaction.status = paymentResult.status === 'succeeded' ? 'verified' : paymentResult.status;
    transaction.verifiedAt = paymentResult.paidAt ?? new Date();
    transaction.verifiedBy = verifiedBy;
    transaction.gateway = {
      ...transaction.gateway,
      type: transaction.gateway?.type ?? 'manual',
      verificationData: paymentResult.metadata,
    };

    await transaction.save();

    // Trigger hook
    this._triggerHook('payment.verified', {
      transaction,
      paymentResult,
      verifiedBy,
    });

    return {
      transaction,
      paymentResult,
      status: transaction.status,
    };
  }

  /**
   * Get payment status
   *
   * @param paymentIntentId - Payment intent ID, session ID, or transaction ID
   * @returns { transaction, status }
   */
  async getStatus(paymentIntentId: string): Promise<PaymentStatusResult> {
    const TransactionModel = this.models.Transaction;
    const transaction = await this._findTransaction(TransactionModel, paymentIntentId);

    if (!transaction) {
      throw new TransactionNotFoundError(paymentIntentId);
    }

    // Get provider
    const gatewayType = transaction.gateway?.type ?? 'manual';
    const provider = this.providers[gatewayType];

    if (!provider) {
      throw new ProviderNotFoundError(gatewayType, Object.keys(this.providers));
    }

    // Get status from provider
    let paymentResult: PaymentResultData | null = null;
    try {
      paymentResult = await provider.getStatus(paymentIntentId);
    } catch (error) {
      this.logger.warn('Failed to get payment status from provider:', error);
      // Return transaction status as fallback
      return {
        transaction,
        status: transaction.status,
        provider: gatewayType,
      };
    }

    return {
      transaction,
      paymentResult,
      status: paymentResult.status,
      provider: gatewayType,
    };
  }

  /**
   * Refund a payment
   *
   * @param paymentId - Payment intent ID, session ID, or transaction ID
   * @param amount - Amount to refund (optional, full refund if not provided)
   * @param options - Refund options
   * @returns { transaction, refundResult }
   */
  async refund(
    paymentId: string,
    amount: number | null = null,
    options: RefundOptions = {}
  ): Promise<PaymentRefundResult> {
    const { reason = null } = options;

    const TransactionModel = this.models.Transaction;
    const transaction = await this._findTransaction(TransactionModel, paymentId);

    if (!transaction) {
      throw new TransactionNotFoundError(paymentId);
    }

    if (transaction.status !== 'verified' && transaction.status !== 'completed') {
      throw new RefundError(transaction._id.toString(), 'Only verified/completed transactions can be refunded');
    }

    // Get provider
    const gatewayType = transaction.gateway?.type ?? 'manual';
    const provider = this.providers[gatewayType];

    if (!provider) {
      throw new ProviderNotFoundError(gatewayType, Object.keys(this.providers));
    }

    // Check if provider supports refunds
    const capabilities = provider.getCapabilities();
    if (!capabilities.supportsRefunds) {
      throw new RefundNotSupportedError(gatewayType);
    }

    // Calculate refundable amount
    const refundedSoFar = transaction.refundedAmount ?? 0;
    const refundableAmount = transaction.amount - refundedSoFar;
    const refundAmount = amount ?? refundableAmount;

    // Validate refund amount
    if (refundAmount <= 0) {
      throw new ValidationError(`Refund amount must be positive, got ${refundAmount}`);
    }

    if (refundAmount > refundableAmount) {
      throw new ValidationError(
        `Refund amount (${refundAmount}) exceeds refundable balance (${refundableAmount})`,
        { refundAmount, refundableAmount, alreadyRefunded: refundedSoFar }
      );
    }

    // Refund via provider
    let refundResult;

    try {
      refundResult = await provider.refund(paymentId, refundAmount, { reason: reason ?? undefined });
    } catch (error) {
      this.logger.error('Refund failed:', error);
      throw new RefundError(paymentId, (error as Error).message);
    }

    // Create separate refund transaction (EXPENSE) for proper accounting
    const refundTransactionType: TransactionTypeValue = 
      this.config.transactionTypeMapping?.refund ?? TRANSACTION_TYPE.EXPENSE;

    // Reverse commission proportionally for refund
    const refundCommission = transaction.commission
      ? reverseCommission(transaction.commission, transaction.amount, refundAmount)
      : null;

    const refundTransaction = await TransactionModel.create({
      organizationId: transaction.organizationId,
      customerId: transaction.customerId,
      amount: refundAmount,
      currency: transaction.currency,
      category: transaction.category,
      type: refundTransactionType, // EXPENSE - money going out
      method: transaction.method ?? 'manual',
      status: 'completed',
      gateway: {
        type: transaction.gateway?.type ?? 'manual',
        paymentIntentId: refundResult.id,
        provider: refundResult.provider,
      },
      paymentDetails: transaction.paymentDetails,
      ...(refundCommission && { commission: refundCommission }), // Reversed commission
      // Polymorphic reference (copy from original transaction)
      ...(transaction.referenceId && { referenceId: transaction.referenceId }),
      ...(transaction.referenceModel && { referenceModel: transaction.referenceModel }),
      metadata: {
        ...transaction.metadata,
        isRefund: true,
        originalTransactionId: transaction._id.toString(),
        refundReason: reason,
        refundResult: refundResult.metadata,
      },
      idempotencyKey: `refund_${transaction._id}_${Date.now()}`,
    }) as TransactionDocument;

    // Update original transaction status
    const isPartialRefund = refundAmount < transaction.amount;
    transaction.status = isPartialRefund ? 'partially_refunded' : 'refunded';
    transaction.refundedAmount = (transaction.refundedAmount ?? 0) + refundAmount;
    transaction.refundedAt = refundResult.refundedAt ?? new Date();
    transaction.metadata = {
      ...transaction.metadata,
      refundTransactionId: refundTransaction._id.toString(),
      refundReason: reason,
    };

    await transaction.save();

    // Trigger hook
    this._triggerHook('payment.refunded', {
      transaction,
      refundTransaction,
      refundResult,
      refundAmount,
      reason,
      isPartialRefund,
    });

    return {
      transaction,
      refundTransaction,
      refundResult,
      status: transaction.status,
    };
  }

  /**
   * Handle webhook from payment provider
   *
   * @param provider - Provider name
   * @param payload - Webhook payload
   * @param headers - Request headers
   * @returns { event, transaction }
   */
  async handleWebhook(
    providerName: string,
    payload: unknown,
    headers: Record<string, string> = {}
  ): Promise<WebhookResult> {
    const provider = this.providers[providerName];

    if (!provider) {
      throw new ProviderNotFoundError(providerName, Object.keys(this.providers));
    }

    // Check if provider supports webhooks
    const capabilities = provider.getCapabilities();
    if (!capabilities.supportsWebhooks) {
      throw new ProviderCapabilityError(providerName, 'webhooks');
    }

    // Process webhook via provider
    let webhookEvent;
    try {
      webhookEvent = await provider.handleWebhook(payload, headers);
    } catch (error) {
      this.logger.error('Webhook processing failed:', error);
      throw new ProviderError(
        `Webhook processing failed for ${providerName}: ${(error as Error).message}`,
        'WEBHOOK_PROCESSING_FAILED',
        { retryable: false }
      );
    }

    // Validate webhook event structure
    if (!webhookEvent?.data?.sessionId && !webhookEvent?.data?.paymentIntentId) {
      throw new ValidationError(
        `Invalid webhook event structure from ${providerName}: missing sessionId or paymentIntentId`,
        { provider: providerName, eventType: webhookEvent?.type }
      );
    }

    // Find transaction by sessionId first (for checkout flows), then paymentIntentId
    const TransactionModel = this.models.Transaction;
    let transaction: TransactionDocument | null = null;

    if (webhookEvent.data.sessionId) {
      transaction = await (TransactionModel as unknown as {
        findOne(filter: object): Promise<TransactionDocument | null>;
      }).findOne({
        'gateway.sessionId': webhookEvent.data.sessionId,
      });
    }

    if (!transaction && webhookEvent.data.paymentIntentId) {
      transaction = await (TransactionModel as unknown as {
        findOne(filter: object): Promise<TransactionDocument | null>;
      }).findOne({
        'gateway.paymentIntentId': webhookEvent.data.paymentIntentId,
      });
    }

    if (!transaction) {
      this.logger.warn('Transaction not found for webhook event', {
        provider: providerName,
        eventId: webhookEvent.id,
        sessionId: webhookEvent.data.sessionId,
        paymentIntentId: webhookEvent.data.paymentIntentId,
      });
      throw new TransactionNotFoundError(
        webhookEvent.data.sessionId ?? webhookEvent.data.paymentIntentId ?? 'unknown'
      );
    }

    // Update gateway with complete information from webhook
    if (webhookEvent.data.sessionId && !transaction.gateway?.sessionId) {
      transaction.gateway = {
        ...transaction.gateway,
        type: transaction.gateway?.type ?? 'manual',
        sessionId: webhookEvent.data.sessionId,
      };
    }
    if (webhookEvent.data.paymentIntentId && !transaction.gateway?.paymentIntentId) {
      transaction.gateway = {
        ...transaction.gateway,
        type: transaction.gateway?.type ?? 'manual',
        paymentIntentId: webhookEvent.data.paymentIntentId,
      };
    }

    // Check for duplicate webhook processing (idempotency)
    if (transaction.webhook?.eventId === webhookEvent.id && transaction.webhook?.processedAt) {
      this.logger.warn('Webhook already processed', {
        transactionId: transaction._id,
        eventId: webhookEvent.id,
      });
      return {
        event: webhookEvent,
        transaction,
        status: 'already_processed',
      };
    }

    // Update transaction based on webhook event
    transaction.webhook = {
      eventId: webhookEvent.id,
      eventType: webhookEvent.type,
      receivedAt: new Date(),
      processedAt: new Date(),
      data: webhookEvent.data,
    };

    // Update status based on webhook type
    if (webhookEvent.type === 'payment.succeeded') {
      transaction.status = 'verified';
      transaction.verifiedAt = webhookEvent.createdAt;
    } else if (webhookEvent.type === 'payment.failed') {
      transaction.status = 'failed';
    } else if (webhookEvent.type === 'refund.succeeded') {
      transaction.status = 'refunded';
      transaction.refundedAt = webhookEvent.createdAt;
    }

    await transaction.save();

    // Trigger hook
    this._triggerHook(`payment.webhook.${webhookEvent.type}`, {
      event: webhookEvent,
      transaction,
    });

    return {
      event: webhookEvent,
      transaction,
      status: 'processed',
    };
  }

  /**
   * List payments/transactions with filters
   *
   * @param filters - Query filters
   * @param options - Query options (limit, skip, sort)
   * @returns Transactions
   */
  async list(
    filters: Record<string, unknown> = {},
    options: ListOptions = {}
  ): Promise<TransactionDocument[]> {
    const TransactionModel = this.models.Transaction;
    const { limit = 50, skip = 0, sort = { createdAt: -1 } } = options;

    const transactions = await (TransactionModel as unknown as {
      find(filter: object): { limit(n: number): { skip(n: number): { sort(s: object): Promise<TransactionDocument[]> } } };
    })
      .find(filters)
      .limit(limit)
      .skip(skip)
      .sort(sort);

    return transactions;
  }

  /**
   * Get payment/transaction by ID
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
   * Get provider instance
   *
   * @param providerName - Provider name
   * @returns Provider instance
   */
  getProvider(providerName: string): PaymentProviderInterface {
    const provider = this.providers[providerName];
    if (!provider) {
      throw new ProviderNotFoundError(providerName, Object.keys(this.providers));
    }
    return provider;
  }

  /**
   * Trigger event hook (fire-and-forget, non-blocking)
   * @private
   */
  private _triggerHook(event: string, data: unknown): void {
    triggerHook(this.hooks, event, data, this.logger);
  }

  /**
   * Find transaction by sessionId, paymentIntentId, or transaction ID
   * @private
   */
  private async _findTransaction(
    TransactionModel: MongooseModel<TransactionDocument>,
    identifier: string
  ): Promise<TransactionDocument | null> {
    let transaction = await (TransactionModel as unknown as {
      findOne(filter: object): Promise<TransactionDocument | null>;
    }).findOne({
      'gateway.sessionId': identifier,
    });

    if (!transaction) {
      transaction = await (TransactionModel as unknown as {
        findOne(filter: object): Promise<TransactionDocument | null>;
      }).findOne({
        'gateway.paymentIntentId': identifier,
      });
    }

    if (!transaction) {
      transaction = await TransactionModel.findById(identifier) as TransactionDocument | null;
    }

    return transaction;
  }
}

export default PaymentService;

