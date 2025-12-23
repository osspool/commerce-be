/**
 * Monetization Service
 * @classytic/revenue
 *
 * Framework-agnostic monetization management service with DI
 * Handles purchases, subscriptions, and free items using provider system
 */

import { nanoid } from 'nanoid';
import {
  MissingRequiredFieldError,
  InvalidAmountError,
  ProviderNotFoundError,
  SubscriptionNotFoundError,
  ModelNotRegisteredError,
  SubscriptionNotActiveError,
  PaymentIntentCreationError,
  InvalidStateTransitionError,
} from '../core/errors.js';
import { triggerHook } from '../utils/hooks.js';
import { resolveCategory } from '../utils/category-resolver.js';
import { calculateCommission } from '../utils/commission.js';
import { MONETIZATION_TYPES } from '../enums/monetization.enums.js';
import { TRANSACTION_TYPE } from '../enums/transaction.enums.js';
import type { Container } from '../core/container.js';
import type {
  ModelsRegistry,
  ProvidersRegistry,
  HooksRegistry,
  RevenueConfig,
  Logger,
  MonetizationCreateParams,
  MonetizationCreateResult,
  ActivateOptions,
  RenewalParams,
  CancelOptions,
  PauseOptions,
  ResumeOptions,
  ListOptions,
  SubscriptionDocument,
  TransactionDocument,
  PaymentIntentData,
  TransactionTypeValue,
} from '../types/index.js';

/**
 * Monetization Service
 * Uses DI container for all dependencies
 */
export class MonetizationService {
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
   * Create a new monetization (purchase, subscription, or free item)
   *
   * @param params - Monetization parameters
   *
   * @example
   * // One-time purchase
   * await revenue.monetization.create({
   *   data: {
   *     organizationId: '...',
   *     customerId: '...',
   *     referenceId: order._id,
   *     referenceModel: 'Order',
   *   },
   *   planKey: 'one_time',
   *   monetizationType: 'purchase',
   *   gateway: 'bkash',
   *   amount: 1500,
   * });
   *
   * // Recurring subscription
   * await revenue.monetization.create({
   *   data: {
   *     organizationId: '...',
   *     customerId: '...',
   *     referenceId: subscription._id,
   *     referenceModel: 'Subscription',
   *   },
   *   planKey: 'monthly',
   *   monetizationType: 'subscription',
   *   gateway: 'stripe',
   *   amount: 2000,
   * });
   *
   * @returns Result with subscription, transaction, and paymentIntent
   */
  async create(params: MonetizationCreateParams): Promise<MonetizationCreateResult> {
    const {
      data,
      planKey,
      amount,
      currency = 'BDT',
      gateway = 'manual',
      entity = null,
      monetizationType = MONETIZATION_TYPES.SUBSCRIPTION,
      paymentData,
      metadata = {},
      idempotencyKey = null,
    } = params;

    // Validate required fields
    // Note: organizationId is OPTIONAL (only needed for multi-tenant)

    if (!planKey) {
      throw new MissingRequiredFieldError('planKey');
    }

    if (amount < 0) {
      throw new InvalidAmountError(amount);
    }

    const isFree = amount === 0;

    // Get provider
    const provider = this.providers[gateway];
    if (!provider) {
      throw new ProviderNotFoundError(gateway, Object.keys(this.providers));
    }

    // Create payment intent if not free
    let paymentIntent: PaymentIntentData | null = null;
    let transaction: TransactionDocument | null = null;

    if (!isFree) {
      // Create payment intent via provider
      try {
        paymentIntent = await provider.createIntent({
          amount,
          currency,
          metadata: {
            ...metadata,
            type: 'subscription',
            planKey,
          },
        });
      } catch (error) {
        throw new PaymentIntentCreationError(gateway, error as Error);
      }

      // Resolve category based on entity and monetizationType
      const category = resolveCategory(entity, monetizationType, this.config.categoryMappings);

      // Resolve transaction type using config mapping or default to 'income'
      const transactionType: TransactionTypeValue = 
        this.config.transactionTypeMapping?.subscription ??
        this.config.transactionTypeMapping?.[monetizationType] ??
        TRANSACTION_TYPE.INCOME;

      // Calculate commission if configured
      const commissionRate = this.config.commissionRates?.[category] ?? 0;
      const gatewayFeeRate = this.config.gatewayFeeRates?.[gateway] ?? 0;
      const commission = calculateCommission(amount, commissionRate, gatewayFeeRate);

      // Create transaction record
      const TransactionModel = this.models.Transaction;
      transaction = await TransactionModel.create({
        organizationId: data.organizationId,
        customerId: data.customerId ?? null,
        amount,
        currency,
        category,
        type: transactionType,
        method: ((paymentData as Record<string, unknown>)?.method as string) ?? 'manual',
        status: paymentIntent.status === 'succeeded' ? 'verified' : 'pending',
        gateway: {
          type: gateway,
          sessionId: paymentIntent.sessionId,
          paymentIntentId: paymentIntent.paymentIntentId,
          provider: paymentIntent.provider,
          metadata: paymentIntent.metadata,
        },
        paymentDetails: {
          provider: gateway,
          ...paymentData,
        },
        ...(commission && { commission }), // Only include if commission exists
        // Polymorphic reference (top-level, not metadata)
        ...(data.referenceId && { referenceId: data.referenceId }),
        ...(data.referenceModel && { referenceModel: data.referenceModel }),
        metadata: {
          ...metadata,
          planKey,
          entity,
          monetizationType,
          paymentIntentId: paymentIntent.id,
        },
        idempotencyKey: idempotencyKey ?? `sub_${nanoid(16)}`,
      }) as TransactionDocument;
    }

    // Create subscription record (if Subscription model exists)
    let subscription: SubscriptionDocument | null = null;
    if (this.models.Subscription) {
      const SubscriptionModel = this.models.Subscription;

      // Create subscription with proper reference tracking
      const subscriptionData = {
        organizationId: data.organizationId,
        customerId: data.customerId ?? null,
        planKey,
        amount,
        currency,
        status: isFree ? 'active' : 'pending',
        isActive: isFree,
        gateway,
        transactionId: transaction?._id ?? null,
        paymentIntentId: paymentIntent?.id ?? null,
        metadata: {
          ...metadata,
          isFree,
          entity,
          monetizationType,
        },
        ...data,
      } as Record<string, unknown>;

      // Remove referenceId/referenceModel from subscription (they're for transactions)
      delete subscriptionData.referenceId;
      delete subscriptionData.referenceModel;

      subscription = await SubscriptionModel.create(subscriptionData) as SubscriptionDocument;
    }

    // Trigger hooks - emit specific event based on monetization type
    const eventData = {
      subscription,
      transaction,
      paymentIntent,
      isFree,
      monetizationType,
    };

    // Emit specific monetization event
    if (monetizationType === MONETIZATION_TYPES.PURCHASE) {
      this._triggerHook('purchase.created', eventData);
    } else if (monetizationType === MONETIZATION_TYPES.SUBSCRIPTION) {
      this._triggerHook('subscription.created', eventData);
    } else if (monetizationType === MONETIZATION_TYPES.FREE) {
      this._triggerHook('free.created', eventData);
    }

    // Also emit generic event for backward compatibility
    this._triggerHook('monetization.created', eventData);

    return {
      subscription,
      transaction,
      paymentIntent,
    };
  }

  /**
   * Activate subscription after payment verification
   *
   * @param subscriptionId - Subscription ID or transaction ID
   * @param options - Activation options
   * @returns Updated subscription
   */
  async activate(
    subscriptionId: string,
    options: ActivateOptions = {}
  ): Promise<SubscriptionDocument> {
    const { timestamp = new Date() } = options;

    if (!this.models.Subscription) {
      throw new ModelNotRegisteredError('Subscription');
    }

    const SubscriptionModel = this.models.Subscription;
    const subscription = await SubscriptionModel.findById(subscriptionId) as SubscriptionDocument | null;

    if (!subscription) {
      throw new SubscriptionNotFoundError(subscriptionId);
    }

    if (subscription.isActive) {
      this.logger.warn('Subscription already active', { subscriptionId });
      return subscription;
    }

    // Calculate period dates based on plan
    const periodEnd = this._calculatePeriodEnd(subscription.planKey, timestamp);

    // Update subscription
    subscription.isActive = true;
    subscription.status = 'active';
    subscription.startDate = timestamp;
    subscription.endDate = periodEnd;
    subscription.activatedAt = timestamp;

    await subscription.save();

    // Trigger hook
    this._triggerHook('subscription.activated', {
      subscription,
      activatedAt: timestamp,
    });

    return subscription;
  }

  /**
   * Renew subscription
   *
   * @param subscriptionId - Subscription ID
   * @param params - Renewal parameters
   * @returns { subscription, transaction, paymentIntent }
   */
  async renew(
    subscriptionId: string,
    params: RenewalParams = {}
  ): Promise<MonetizationCreateResult> {
    const {
      gateway = 'manual',
      entity = null,
      paymentData,
      metadata = {},
      idempotencyKey = null,
    } = params;

    if (!this.models.Subscription) {
      throw new ModelNotRegisteredError('Subscription');
    }

    const SubscriptionModel = this.models.Subscription;
    const subscription = await SubscriptionModel.findById(subscriptionId) as SubscriptionDocument | null;

    if (!subscription) {
      throw new SubscriptionNotFoundError(subscriptionId);
    }

    if (subscription.amount === 0) {
      throw new InvalidAmountError(0, 'Free subscriptions do not require renewal');
    }

    // Get provider
    const provider = this.providers[gateway];
    if (!provider) {
      throw new ProviderNotFoundError(gateway, Object.keys(this.providers));
    }

    // Create payment intent
    let paymentIntent: PaymentIntentData | null = null;
    try {
      paymentIntent = await provider.createIntent({
        amount: subscription.amount,
        currency: subscription.currency ?? 'BDT',
        metadata: {
          ...metadata,
          type: 'subscription_renewal',
          subscriptionId: subscription._id.toString(),
        },
      });
    } catch (error) {
      this.logger.error('Failed to create payment intent for renewal:', error);
      throw new PaymentIntentCreationError(gateway, error as Error);
    }

    // Resolve category - use provided entity or inherit from subscription metadata
    const effectiveEntity = entity ?? (subscription.metadata as Record<string, unknown>)?.entity as string | null;
    const effectiveMonetizationType = 
      ((subscription.metadata as Record<string, unknown>)?.monetizationType as string) ?? MONETIZATION_TYPES.SUBSCRIPTION;
    const category = resolveCategory(effectiveEntity, effectiveMonetizationType as 'subscription' | 'purchase' | 'free', this.config.categoryMappings);

    // Resolve transaction type using config mapping or default to 'income'
    const transactionType: TransactionTypeValue = 
      this.config.transactionTypeMapping?.subscription_renewal ??
      this.config.transactionTypeMapping?.subscription ??
      this.config.transactionTypeMapping?.[effectiveMonetizationType] ??
      TRANSACTION_TYPE.INCOME;

    // Calculate commission if configured
    const commissionRate = this.config.commissionRates?.[category] ?? 0;
    const gatewayFeeRate = this.config.gatewayFeeRates?.[gateway] ?? 0;
    const commission = calculateCommission(subscription.amount, commissionRate, gatewayFeeRate);

    // Create transaction
    const TransactionModel = this.models.Transaction;
    const transaction = await TransactionModel.create({
      organizationId: subscription.organizationId,
      customerId: subscription.customerId,
      amount: subscription.amount,
      currency: subscription.currency ?? 'BDT',
      category,
      type: transactionType,
      method: ((paymentData as Record<string, unknown>)?.method as string) ?? 'manual',
      status: paymentIntent.status === 'succeeded' ? 'verified' : 'pending',
      gateway: {
        type: gateway,
        sessionId: paymentIntent.sessionId,
        paymentIntentId: paymentIntent.paymentIntentId,
        provider: paymentIntent.provider,
        metadata: paymentIntent.metadata,
      },
      paymentDetails: {
        provider: gateway,
        ...paymentData,
      },
      ...(commission && { commission }), // Only include if commission exists
      // Polymorphic reference to subscription
      referenceId: subscription._id,
      referenceModel: 'Subscription',
      metadata: {
        ...metadata,
        subscriptionId: subscription._id.toString(), // Keep for backward compat
        entity: effectiveEntity,
        monetizationType: effectiveMonetizationType,
        isRenewal: true,
        paymentIntentId: paymentIntent.id,
      },
      idempotencyKey: idempotencyKey ?? `renewal_${nanoid(16)}`,
    }) as TransactionDocument;

    // Update subscription
    subscription.status = 'pending_renewal' as SubscriptionDocument['status'];
    subscription.renewalTransactionId = transaction._id;
    subscription.renewalCount = (subscription.renewalCount ?? 0) + 1;
    await subscription.save();

    // Trigger hook
    this._triggerHook('subscription.renewed', {
      subscription,
      transaction,
      paymentIntent,
      renewalCount: subscription.renewalCount,
    });

    return {
      subscription,
      transaction,
      paymentIntent,
    };
  }

  /**
   * Cancel subscription
   *
   * @param subscriptionId - Subscription ID
   * @param options - Cancellation options
   * @returns Updated subscription
   */
  async cancel(
    subscriptionId: string,
    options: CancelOptions = {}
  ): Promise<SubscriptionDocument> {
    const { immediate = false, reason = null } = options;

    if (!this.models.Subscription) {
      throw new ModelNotRegisteredError('Subscription');
    }

    const SubscriptionModel = this.models.Subscription;
    const subscription = await SubscriptionModel.findById(subscriptionId) as SubscriptionDocument | null;

    if (!subscription) {
      throw new SubscriptionNotFoundError(subscriptionId);
    }

    const now = new Date();

    if (immediate) {
      subscription.isActive = false;
      subscription.status = 'cancelled';
      subscription.canceledAt = now;
      subscription.cancellationReason = reason;
    } else {
      // Schedule cancellation at period end
      subscription.cancelAt = subscription.endDate ?? now;
      subscription.cancellationReason = reason;
    }

    await subscription.save();

    // Trigger hook
    this._triggerHook('subscription.cancelled', {
      subscription,
      immediate,
      reason,
      canceledAt: immediate ? now : subscription.cancelAt,
    });

    return subscription;
  }

  /**
   * Pause subscription
   *
   * @param subscriptionId - Subscription ID
   * @param options - Pause options
   * @returns Updated subscription
   */
  async pause(
    subscriptionId: string,
    options: PauseOptions = {}
  ): Promise<SubscriptionDocument> {
    const { reason = null } = options;

    if (!this.models.Subscription) {
      throw new ModelNotRegisteredError('Subscription');
    }

    const SubscriptionModel = this.models.Subscription;
    const subscription = await SubscriptionModel.findById(subscriptionId) as SubscriptionDocument | null;

    if (!subscription) {
      throw new SubscriptionNotFoundError(subscriptionId);
    }

    if (!subscription.isActive) {
      throw new SubscriptionNotActiveError(subscriptionId, 'Only active subscriptions can be paused');
    }

    const pausedAt = new Date();
    subscription.isActive = false;
    subscription.status = 'paused';
    subscription.pausedAt = pausedAt;
    subscription.pauseReason = reason;

    await subscription.save();

    // Trigger hook
    this._triggerHook('subscription.paused', {
      subscription,
      reason,
      pausedAt,
    });

    return subscription;
  }

  /**
   * Resume subscription
   *
   * @param subscriptionId - Subscription ID
   * @param options - Resume options
   * @returns Updated subscription
   */
  async resume(
    subscriptionId: string,
    options: ResumeOptions = {}
  ): Promise<SubscriptionDocument> {
    const { extendPeriod = false } = options;

    if (!this.models.Subscription) {
      throw new ModelNotRegisteredError('Subscription');
    }

    const SubscriptionModel = this.models.Subscription;
    const subscription = await SubscriptionModel.findById(subscriptionId) as SubscriptionDocument | null;

    if (!subscription) {
      throw new SubscriptionNotFoundError(subscriptionId);
    }

    if (!subscription.pausedAt) {
      throw new InvalidStateTransitionError(
        'resume',
        'paused',
        subscription.status,
        'Only paused subscriptions can be resumed'
      );
    }

    const now = new Date();
    const pausedAt = new Date(subscription.pausedAt);
    const pauseDuration = now.getTime() - pausedAt.getTime();

    subscription.isActive = true;
    subscription.status = 'active';
    subscription.pausedAt = null;
    subscription.pauseReason = null;

    // Optionally extend period by pause duration
    if (extendPeriod && subscription.endDate) {
      const currentEnd = new Date(subscription.endDate);
      subscription.endDate = new Date(currentEnd.getTime() + pauseDuration);
    }

    await subscription.save();

    // Trigger hook
    this._triggerHook('subscription.resumed', {
      subscription,
      extendPeriod,
      pauseDuration,
      resumedAt: now,
    });

    return subscription;
  }

  /**
   * List subscriptions with filters
   *
   * @param filters - Query filters
   * @param options - Query options (limit, skip, sort)
   * @returns Subscriptions
   */
  async list(
    filters: Record<string, unknown> = {},
    options: ListOptions = {}
  ): Promise<SubscriptionDocument[]> {
    if (!this.models.Subscription) {
      throw new ModelNotRegisteredError('Subscription');
    }

    const SubscriptionModel = this.models.Subscription;
    const { limit = 50, skip = 0, sort = { createdAt: -1 } } = options;

    const subscriptions = await (SubscriptionModel as unknown as {
      find(filter: object): { limit(n: number): { skip(n: number): { sort(s: object): Promise<SubscriptionDocument[]> } } };
    })
      .find(filters)
      .limit(limit)
      .skip(skip)
      .sort(sort);

    return subscriptions;
  }

  /**
   * Get subscription by ID
   *
   * @param subscriptionId - Subscription ID
   * @returns Subscription
   */
  async get(subscriptionId: string): Promise<SubscriptionDocument> {
    if (!this.models.Subscription) {
      throw new ModelNotRegisteredError('Subscription');
    }

    const SubscriptionModel = this.models.Subscription;
    const subscription = await SubscriptionModel.findById(subscriptionId) as SubscriptionDocument | null;

    if (!subscription) {
      throw new SubscriptionNotFoundError(subscriptionId);
    }

    return subscription;
  }

  /**
   * Calculate period end date based on plan key
   * @private
   */
  private _calculatePeriodEnd(planKey: string, startDate: Date = new Date()): Date {
    const start = new Date(startDate);
    const end = new Date(start);

    switch (planKey) {
      case 'monthly':
        end.setMonth(end.getMonth() + 1);
        break;
      case 'quarterly':
        end.setMonth(end.getMonth() + 3);
        break;
      case 'yearly':
        end.setFullYear(end.getFullYear() + 1);
        break;
      default:
        // Default to 30 days
        end.setDate(end.getDate() + 30);
    }

    return end;
  }

  /**
   * Trigger event hook (fire-and-forget, non-blocking)
   * @private
   */
  private _triggerHook(event: string, data: unknown): void {
    triggerHook(this.hooks, event, data, this.logger);
  }
}

export default MonetizationService;

