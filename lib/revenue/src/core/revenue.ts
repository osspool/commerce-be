/**
 * Revenue - Modern Payment Management
 * @classytic/revenue
 *
 * Fluent Builder API with integrated services
 * Less code, more power
 *
 * Inspired by: Vercel AI SDK, Stripe SDK, tRPC
 */

import { nanoid } from 'nanoid';
import { Container } from './container.js';
import { EventBus, createEventBus } from './events.js';
import { PluginManager, type RevenuePlugin, type PluginContext, type PluginLogger } from './plugin.js';
import { type Result, tryCatch } from './result.js';
import { IdempotencyManager, createIdempotencyManager } from '../utils/idempotency.js';
import { retry, type RetryConfig, CircuitBreaker, createCircuitBreaker } from '../utils/retry.js';
import { MonetizationService } from '../services/monetization.service.js';
import { PaymentService } from '../services/payment.service.js';
import { TransactionService } from '../services/transaction.service.js';
import { EscrowService } from '../services/escrow.service.js';
import { ConfigurationError } from './errors.js';
import { PaymentProvider } from '../providers/base.js';
import type { HooksRegistry, MongooseModel, PaymentProviderInterface } from '../types/index.js';

// ============ TYPES ============

/** Internal config for Revenue instance */
export interface InternalConfig {
  defaultCurrency: string;
  commissionRate: number;
  gatewayFeeRate: number;
  targetModels?: string[];
  categoryMappings?: Record<string, string>;
}

export interface RevenueOptions {
  /** Default currency (ISO 4217) */
  defaultCurrency?: string;
  /** Environment */
  environment?: 'development' | 'staging' | 'production';
  /** Debug mode */
  debug?: boolean;
  /** Retry configuration */
  retry?: Partial<RetryConfig>;
  /** Idempotency TTL in ms */
  idempotencyTtl?: number;
  /** Enable circuit breaker */
  circuitBreaker?: boolean;
  /** Custom logger */
  logger?: PluginLogger;
  /** Commission rate (0-100) */
  commissionRate?: number;
  /** Gateway fee rate (0-100) */
  gatewayFeeRate?: number;
}

export interface ModelsConfig {
  Transaction: MongooseModel<any>;
  Subscription?: MongooseModel<any>;
  [key: string]: MongooseModel<any> | undefined;
}

export interface ProvidersConfig {
  [name: string]: PaymentProvider;
}

type HookHandler = (data: unknown) => void | Promise<void>;

/**
 * Hooks config accepted by the builder.
 *
 * At runtime, hooks are executed via the `HooksRegistry` shape (event -> handlers[]).
 * This type also accepts a legacy shorthand (event -> handler or handlers[]).
 */
export type HooksConfig = HooksRegistry | Record<string, HookHandler | HookHandler[] | undefined>;

// ============ REVENUE CLASS ============

/**
 * Revenue - Main entry point
 *
 * @example
 * ```typescript
 * const revenue = Revenue
 *   .create({ defaultCurrency: 'USD' })
 *   .withModels({ Transaction, Subscription })
 *   .withProvider('stripe', new StripeProvider({ apiKey: '...' }))
 *   .withProvider('manual', new ManualProvider())
 *   .withPlugin(auditPlugin())
 *   .build();
 *
 * // Access services directly
 * await revenue.monetization.create({ ... });
 * await revenue.payments.verify({ ... });
 *
 * // Or use events
 * revenue.on('payment.succeeded', (event) => { ... });
 * ```
 */
export class Revenue {
  // ============ CORE ============
  private readonly _container: Container;
  private readonly _events: EventBus;
  private readonly _plugins: PluginManager;
  private readonly _idempotency: IdempotencyManager;
  private readonly _circuitBreaker?: CircuitBreaker;
  private readonly _options: Required<RevenueOptions>;
  private readonly _logger: PluginLogger;
  private readonly _providers: ProvidersConfig;
  private readonly _config: InternalConfig;

  // ============ SERVICES ============
  /** Monetization service - purchases, subscriptions, free items */
  public readonly monetization: MonetizationService;
  /** Payment service - verify, refund, webhooks */
  public readonly payments: PaymentService;
  /** Transaction service - query, update transactions */
  public readonly transactions: TransactionService;
  /** Escrow service - hold, release, splits */
  public readonly escrow: EscrowService;

  private constructor(
    container: Container,
    events: EventBus,
    plugins: PluginManager,
    options: Required<RevenueOptions>,
    providers: ProvidersConfig,
    config: InternalConfig
  ) {
    this._container = container;
    this._events = events;
    this._plugins = plugins;
    this._options = options;
    this._logger = options.logger;
    this._providers = providers;
    this._config = config;

    // Initialize idempotency
    this._idempotency = createIdempotencyManager({
      ttl: options.idempotencyTtl,
    });

    // Initialize circuit breaker
    if (options.circuitBreaker) {
      this._circuitBreaker = createCircuitBreaker();
    }

    // Register utilities in container
    container.singleton('events', events);
    container.singleton('plugins', plugins);
    container.singleton('idempotency', this._idempotency);
    container.singleton('logger', this._logger);

    // Initialize services
    this.monetization = new MonetizationService(container);
    this.payments = new PaymentService(container);
    this.transactions = new TransactionService(container);
    this.escrow = new EscrowService(container);

    // Freeze for immutability
    Object.freeze(this._providers);
    Object.freeze(this._config);
  }

  // ============ STATIC FACTORY ============

  /**
   * Create a new Revenue builder
   *
   * @example
   * ```typescript
   * const revenue = Revenue
   *   .create({ defaultCurrency: 'BDT' })
   *   .withModels({ Transaction, Subscription })
   *   .withProvider('manual', new ManualProvider())
   *   .build();
   * ```
   */
  static create(options: RevenueOptions = {}): RevenueBuilder {
    return new RevenueBuilder(options);
  }

  // ============ ACCESSORS ============

  /** DI container (for advanced usage) */
  get container(): Container {
    return this._container;
  }

  /** Event bus */
  get events(): EventBus {
    return this._events;
  }

  /** Registered providers (frozen) */
  get providers(): Readonly<ProvidersConfig> {
    return this._providers;
  }

  /** Configuration (frozen) */
  get config(): Readonly<InternalConfig> {
    return this._config;
  }

  /** Default currency */
  get defaultCurrency(): string {
    return this._options.defaultCurrency;
  }

  /** Current environment */
  get environment(): string {
    return this._options.environment;
  }

  // ============ PROVIDER METHODS ============

  /**
   * Get a provider by name
   */
  getProvider(name: string): PaymentProviderInterface {
    const provider = this._providers[name];
    if (!provider) {
      throw new ConfigurationError(
        `Provider "${name}" not found. Available: ${Object.keys(this._providers).join(', ')}`
      );
    }
    return provider as PaymentProviderInterface;
  }

  /**
   * Get all provider names
   */
  getProviderNames(): string[] {
    return Object.keys(this._providers);
  }

  /**
   * Check if provider exists
   */
  hasProvider(name: string): boolean {
    return name in this._providers;
  }

  // ============ EVENT SYSTEM ============

  /**
   * Subscribe to events
   *
   * @example
   * ```typescript
   * revenue.on('payment.succeeded', (event) => {
   *   console.log('Payment:', event.transactionId);
   * });
   * ```
   */
  on: EventBus['on'] = (event, handler) => {
    return this._events.on(event, handler);
  };

  /**
   * Subscribe once
   */
  once: EventBus['once'] = (event, handler) => {
    return this._events.once(event, handler);
  };

  /**
   * Unsubscribe
   */
  off: EventBus['off'] = (event, handler) => {
    this._events.off(event, handler);
  };

  /**
   * Emit an event
   */
  emit: EventBus['emit'] = (event, payload) => {
    this._events.emit(event, payload);
  };

  // ============ RESILIENCE ============

  /**
   * Execute operation with retry and idempotency
   */
  async execute<T>(
    operation: () => Promise<T>,
    options: {
      idempotencyKey?: string;
      params?: unknown;
      useRetry?: boolean;
      useCircuitBreaker?: boolean;
    } = {}
  ): Promise<Result<T, Error>> {
    const { idempotencyKey, params, useRetry = true, useCircuitBreaker = true } = options;

    // Wrap with idempotency if key provided
    const idempotentOp = async () => {
      if (idempotencyKey) {
        const result = await this._idempotency.execute(idempotencyKey, params, operation);
        if (!result.ok) throw result.error;
        return result.value;
      }
      return operation();
    };

    // Wrap with circuit breaker
    const resilientOp = async () => {
      if (useCircuitBreaker && this._circuitBreaker) {
        return this._circuitBreaker.execute(idempotentOp);
      }
      return idempotentOp();
    };

    // Wrap with retry
    if (useRetry && this._options.retry) {
      return tryCatch(() => retry(resilientOp, this._options.retry));
    }

    return tryCatch(resilientOp);
  }

  /**
   * Create plugin context (for advanced usage)
   */
  createContext(meta: { idempotencyKey?: string } = {}): PluginContext {
    return {
      events: this._events,
      logger: this._logger,
      get: <T>(key: string) => this._container.get<T>(key),
      storage: new Map(),
      meta: {
        ...meta,
        requestId: nanoid(12),
        timestamp: new Date(),
      },
    };
  }

  /**
   * Destroy instance and cleanup
   */
  async destroy(): Promise<void> {
    await this._plugins.destroy();
    this._events.clear();
  }
}

// ============ BUILDER ============

/**
 * Revenue Builder - Fluent configuration API
 */
export class RevenueBuilder {
  private options: RevenueOptions;
  private models: ModelsConfig | null = null;
  private providers: ProvidersConfig = {};
  private plugins: RevenuePlugin[] = [];
  private hooks: HooksRegistry = {};
  private categoryMappings: Record<string, string> = {};

  constructor(options: RevenueOptions = {}) {
    this.options = options;
  }

  /**
   * Register models (required)
   *
   * @example
   * ```typescript
   * .withModels({
   *   Transaction: TransactionModel,
   *   Subscription: SubscriptionModel,
   * })
   * ```
   */
  withModels(models: ModelsConfig): this {
    this.models = models;
    return this;
  }

  /**
   * Register a single model
   */
  withModel(name: string, model: MongooseModel<any>): this {
    if (!this.models) {
      this.models = { Transaction: model } as ModelsConfig;
    }
    (this.models as any)[name] = model;
    return this;
  }

  /**
   * Register a payment provider
   *
   * @example
   * ```typescript
   * .withProvider('stripe', new StripeProvider({ apiKey: '...' }))
   * .withProvider('manual', new ManualProvider())
   * ```
   */
  withProvider(name: string, provider: PaymentProvider): this {
    this.providers[name] = provider;
    return this;
  }

  /**
   * Register multiple providers at once
   */
  withProviders(providers: ProvidersConfig): this {
    this.providers = { ...this.providers, ...providers };
    return this;
  }

  /**
   * Register a plugin
   *
   * @example
   * ```typescript
   * .withPlugin(loggingPlugin())
   * .withPlugin(auditPlugin({ store: saveToDb }))
   * ```
   */
  withPlugin(plugin: RevenuePlugin): this {
    this.plugins.push(plugin);
    return this;
  }

  /**
   * Register multiple plugins
   */
  withPlugins(plugins: RevenuePlugin[]): this {
    this.plugins.push(...plugins);
    return this;
  }

  /**
   * Register event hooks (for backward compatibility)
   *
   * @example
   * ```typescript
   * .withHooks({
   *   onPaymentVerified: async (tx) => { ... },
   *   onSubscriptionRenewed: async (sub) => { ... },
   * })
   * ```
   */
  withHooks(hooks: HooksRegistry): this;
  withHooks(hooks: HooksConfig): this;
  withHooks(hooks: HooksConfig): this {
    const normalized: HooksRegistry = {};

    for (const [event, handlerOrHandlers] of Object.entries(hooks)) {
      if (!handlerOrHandlers) continue;
      normalized[event] = Array.isArray(handlerOrHandlers) ? handlerOrHandlers : [handlerOrHandlers];
    }

    this.hooks = { ...this.hooks, ...normalized };
    return this;
  }

  /**
   * Set retry configuration
   *
   * @example
   * ```typescript
   * .withRetry({ maxAttempts: 5, baseDelay: 2000 })
   * ```
   */
  withRetry(config: Partial<RetryConfig>): this {
    this.options.retry = config;
    return this;
  }

  /**
   * Enable circuit breaker
   */
  withCircuitBreaker(enabled = true): this {
    this.options.circuitBreaker = enabled;
    return this;
  }

  /**
   * Set custom logger
   */
  withLogger(logger: PluginLogger): this {
    this.options.logger = logger;
    return this;
  }

  /**
   * Set environment
   */
  forEnvironment(env: 'development' | 'staging' | 'production'): this {
    this.options.environment = env;
    return this;
  }

  /**
   * Enable debug mode
   */
  withDebug(enabled = true): this {
    this.options.debug = enabled;
    return this;
  }

  /**
   * Set commission rate (0-100)
   */
  withCommission(rate: number, gatewayFeeRate = 0): this {
    this.options.commissionRate = rate;
    this.options.gatewayFeeRate = gatewayFeeRate;
    return this;
  }

  /**
   * Set category mappings (entity → category)
   *
   * @example
   * ```typescript
   * .withCategoryMappings({
   *   PlatformSubscription: 'platform_subscription',
   *   CourseEnrollment: 'course_enrollment',
   *   ProductOrder: 'product_order',
   * })
   * ```
   */
  withCategoryMappings(mappings: Record<string, string>): this {
    this.categoryMappings = { ...this.categoryMappings, ...mappings };
    return this;
  }

  /**
   * Build the Revenue instance
   */
  build(): Revenue {
    // Validate required configuration
    if (!this.models) {
      throw new ConfigurationError(
        'Models are required. Use .withModels({ Transaction, Subscription })'
      );
    }

    if (!this.models.Transaction) {
      throw new ConfigurationError(
        'Transaction model is required in models configuration'
      );
    }

    if (Object.keys(this.providers).length === 0) {
      throw new ConfigurationError(
        'At least one provider is required. Use .withProvider(name, provider)'
      );
    }

    // Create container
    const container = new Container();

    // Default logger
    const defaultLogger: PluginLogger = {
      debug: (msg, data) => this.options.debug && console.debug(`[Revenue] ${msg}`, data ?? ''),
      info: (msg, data) => console.info(`[Revenue] ${msg}`, data ?? ''),
      warn: (msg, data) => console.warn(`[Revenue] ${msg}`, data ?? ''),
      error: (msg, data) => console.error(`[Revenue] ${msg}`, data ?? ''),
    };

    // Resolve options with defaults
    const resolvedOptions: Required<RevenueOptions> = {
      defaultCurrency: this.options.defaultCurrency ?? 'USD',
      environment: this.options.environment ?? 'development',
      debug: this.options.debug ?? false,
      retry: this.options.retry ?? { maxAttempts: 3 },
      idempotencyTtl: this.options.idempotencyTtl ?? 24 * 60 * 60 * 1000,
      circuitBreaker: this.options.circuitBreaker ?? false,
      logger: this.options.logger ?? defaultLogger,
      commissionRate: this.options.commissionRate ?? 0,
      gatewayFeeRate: this.options.gatewayFeeRate ?? 0,
    };

    // Build config for services
    const config: InternalConfig = {
      defaultCurrency: resolvedOptions.defaultCurrency,
      commissionRate: resolvedOptions.commissionRate,
      gatewayFeeRate: resolvedOptions.gatewayFeeRate,
      categoryMappings: this.categoryMappings,
    };

    // Register in container (same format as legacy for service compatibility)
    container.singleton('models', this.models);
    container.singleton('providers', this.providers as Record<string, unknown>);
    container.singleton('hooks', this.hooks);
    container.singleton('config', config);

    // Create event bus
    const events = createEventBus();

    // Create plugin manager
    const pluginManager = new PluginManager();
    for (const plugin of this.plugins) {
      pluginManager.register(plugin);
    }

    // Create Revenue instance using private constructor access
    const revenue = new (Revenue as any)(
      container,
      events,
      pluginManager,
      resolvedOptions,
      this.providers,
      config
    );

    // Initialize plugins
    const ctx = revenue.createContext();
    pluginManager.init(ctx).catch((err: Error) => {
      resolvedOptions.logger.error('Failed to initialize plugins', err);
    });

    return revenue;
  }
}

// ============ FACTORY FUNCTION ============

/**
 * Create Revenue instance (shorthand)
 *
 * @example
 * ```typescript
 * const revenue = createRevenue({
 *   models: { Transaction, Subscription },
 *   providers: { manual: new ManualProvider() },
 * });
 * ```
 */
export function createRevenue(config: {
  models: ModelsConfig;
  providers: ProvidersConfig;
  options?: RevenueOptions;
  plugins?: RevenuePlugin[];
  hooks?: HooksConfig;
}): Revenue {
  let builder = Revenue.create(config.options);

  builder = builder.withModels(config.models);
  builder = builder.withProviders(config.providers);

  if (config.plugins) {
    builder = builder.withPlugins(config.plugins);
  }

  if (config.hooks) {
    builder = builder.withHooks(config.hooks);
  }

  return builder.build();
}

export default Revenue;
