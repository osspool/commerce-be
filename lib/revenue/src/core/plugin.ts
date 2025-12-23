/**
 * Plugin System
 * @classytic/revenue
 *
 * Composable, type-safe plugin architecture
 * Inspired by: Hono middleware, Fastify plugins, Redux middleware
 */

import type { EventBus, RevenueEvents } from './events.js';

// ============ PLUGIN TYPES ============

/**
 * Plugin context passed to hooks
 */
export interface PluginContext {
  /** Event bus for emitting events */
  events: EventBus;
  /** Logger instance */
  logger: PluginLogger;
  /** Get registered service */
  get<T>(key: string): T;
  /** Plugin-specific storage */
  storage: Map<string, unknown>;
  /** Request metadata */
  meta: {
    idempotencyKey?: string;
    requestId: string;
    timestamp: Date;
    [key: string]: unknown;
  };
}

/**
 * Plugin logger interface
 */
export interface PluginLogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

/**
 * Hook function type
 */
export type HookFn<TInput = unknown, TOutput = unknown> = (
  ctx: PluginContext,
  input: TInput,
  next: () => Promise<TOutput>
) => Promise<TOutput>;

/**
 * Available hook points
 */
export interface PluginHooks {
  // Payment hooks
  'payment.create.before': HookFn<PaymentCreateInput>;
  'payment.create.after': HookFn<PaymentCreateInput, PaymentCreateOutput>;
  'payment.verify.before': HookFn<PaymentVerifyInput>;
  'payment.verify.after': HookFn<PaymentVerifyInput, PaymentVerifyOutput>;
  'payment.refund.before': HookFn<RefundInput>;
  'payment.refund.after': HookFn<RefundInput, RefundOutput>;
  
  // Subscription hooks
  'subscription.create.before': HookFn<SubscriptionCreateInput>;
  'subscription.create.after': HookFn<SubscriptionCreateInput, SubscriptionCreateOutput>;
  'subscription.cancel.before': HookFn<SubscriptionCancelInput>;
  'subscription.cancel.after': HookFn<SubscriptionCancelInput, SubscriptionCancelOutput>;
  
  // Transaction hooks
  'transaction.create.before': HookFn<TransactionCreateInput>;
  'transaction.create.after': HookFn<TransactionCreateInput, TransactionCreateOutput>;
  
  // Escrow hooks
  'escrow.hold.before': HookFn<EscrowHoldInput>;
  'escrow.hold.after': HookFn<EscrowHoldInput, EscrowHoldOutput>;
  'escrow.release.before': HookFn<EscrowReleaseInput>;
  'escrow.release.after': HookFn<EscrowReleaseInput, EscrowReleaseOutput>;
}

// Simplified input/output types for hooks
interface PaymentCreateInput { amount: number; currency: string; [key: string]: unknown }
interface PaymentCreateOutput { transactionId: string; intentId: string; [key: string]: unknown }
interface PaymentVerifyInput { id: string; [key: string]: unknown }
interface PaymentVerifyOutput { verified: boolean; [key: string]: unknown }
interface RefundInput { transactionId: string; amount?: number; [key: string]: unknown }
interface RefundOutput { refundId: string; [key: string]: unknown }
interface SubscriptionCreateInput { planKey: string; [key: string]: unknown }
interface SubscriptionCreateOutput { subscriptionId: string; [key: string]: unknown }
interface SubscriptionCancelInput { subscriptionId: string; [key: string]: unknown }
interface SubscriptionCancelOutput { cancelled: boolean; [key: string]: unknown }
interface TransactionCreateInput { amount: number; [key: string]: unknown }
interface TransactionCreateOutput { transactionId: string; [key: string]: unknown }
interface EscrowHoldInput { transactionId: string; [key: string]: unknown }
interface EscrowHoldOutput { held: boolean; [key: string]: unknown }
interface EscrowReleaseInput { transactionId: string; [key: string]: unknown }
interface EscrowReleaseOutput { released: boolean; [key: string]: unknown }

/**
 * Plugin definition
 */
export interface RevenuePlugin {
  /** Unique plugin name */
  name: string;
  /** Plugin version */
  version?: string;
  /** Plugin description */
  description?: string;
  /** Dependencies on other plugins */
  dependencies?: string[];
  /** Hook implementations */
  hooks?: Partial<PluginHooks>;
  /** Event listeners */
  events?: Partial<{
    [K in keyof RevenueEvents]: (event: RevenueEvents[K]) => void | Promise<void>;
  }>;
  /** Initialize plugin */
  init?: (ctx: PluginContext) => void | Promise<void>;
  /** Cleanup plugin */
  destroy?: () => void | Promise<void>;
}

// ============ PLUGIN MANAGER ============

/**
 * Plugin manager - handles registration and execution
 */
export class PluginManager {
  private plugins = new Map<string, RevenuePlugin>();
  private hooks = new Map<string, HookFn[]>();
  private initialized = false;

  /**
   * Register a plugin
   */
  register(plugin: RevenuePlugin): this {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered`);
    }

    // Check dependencies
    if (plugin.dependencies) {
      for (const dep of plugin.dependencies) {
        if (!this.plugins.has(dep)) {
          throw new Error(
            `Plugin "${plugin.name}" requires "${dep}" to be registered first`
          );
        }
      }
    }

    this.plugins.set(plugin.name, plugin);

    // Register hooks
    if (plugin.hooks) {
      for (const [hookName, hookFn] of Object.entries(plugin.hooks)) {
        if (!this.hooks.has(hookName)) {
          this.hooks.set(hookName, []);
        }
        this.hooks.get(hookName)!.push(hookFn as HookFn);
      }
    }

    return this;
  }

  /**
   * Initialize all plugins
   */
  async init(ctx: PluginContext): Promise<void> {
    if (this.initialized) return;

    for (const plugin of this.plugins.values()) {
      if (plugin.init) {
        await plugin.init(ctx);
      }

      // Register event listeners
      if (plugin.events) {
        for (const [event, handler] of Object.entries(plugin.events)) {
          ctx.events.on(event as keyof RevenueEvents, handler as any);
        }
      }
    }

    this.initialized = true;
  }

  /**
   * Execute a hook chain
   */
  async executeHook<TInput, TOutput>(
    hookName: string,
    ctx: PluginContext,
    input: TInput,
    execute: () => Promise<TOutput>
  ): Promise<TOutput> {
    const hooks = this.hooks.get(hookName) ?? [];
    
    if (hooks.length === 0) {
      return execute();
    }

    // Build middleware chain
    let index = 0;
    const next = async (): Promise<TOutput> => {
      if (index >= hooks.length) {
        return execute();
      }
      const hook = hooks[index++];
      return hook(ctx, input, next) as Promise<TOutput>;
    };

    return next();
  }

  /**
   * Check if plugin is registered
   */
  has(name: string): boolean {
    return this.plugins.has(name);
  }

  /**
   * Get a plugin by name
   */
  get(name: string): RevenuePlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Get all registered plugins
   */
  list(): RevenuePlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Destroy all plugins
   */
  async destroy(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.destroy) {
        await plugin.destroy();
      }
    }
    this.plugins.clear();
    this.hooks.clear();
    this.initialized = false;
  }
}

// ============ BUILT-IN PLUGINS ============

/**
 * Logging plugin - logs all operations
 */
export function loggingPlugin(options: { level?: 'debug' | 'info' } = {}): RevenuePlugin {
  const level = options.level ?? 'info';
  
  return {
    name: 'logging',
    version: '1.0.0',
    description: 'Logs all revenue operations',
    hooks: {
      'payment.create.before': async (ctx, input, next) => {
        ctx.logger[level]('Creating payment', { amount: input.amount, currency: input.currency });
        const result = await next();
        ctx.logger[level]('Payment created', { transactionId: (result as any)?.transactionId });
        return result;
      },
      'payment.verify.before': async (ctx, input, next) => {
        ctx.logger[level]('Verifying payment', { id: input.id });
        const result = await next();
        ctx.logger[level]('Payment verified', { verified: (result as any)?.verified });
        return result;
      },
      'payment.refund.before': async (ctx, input, next) => {
        ctx.logger[level]('Processing refund', { transactionId: input.transactionId, amount: input.amount });
        const result = await next();
        ctx.logger[level]('Refund processed', { refundId: (result as any)?.refundId });
        return result;
      },
    },
  };
}

/**
 * Audit plugin - records all operations for compliance
 */
export function auditPlugin(options: { 
  store?: (entry: AuditEntry) => Promise<void> 
} = {}): RevenuePlugin {
  const entries: AuditEntry[] = [];
  
  const store = options.store ?? (async (entry: AuditEntry) => {
    entries.push(entry);
  });

  return {
    name: 'audit',
    version: '1.0.0',
    description: 'Audit trail for all operations',
    hooks: {
      'payment.create.after': async (ctx, input, next) => {
        const result = await next();
        await store({
          action: 'payment.create',
          requestId: ctx.meta.requestId,
          timestamp: ctx.meta.timestamp,
          input: sanitizeInput(input),
          output: sanitizeOutput(result),
          idempotencyKey: ctx.meta.idempotencyKey,
        });
        return result;
      },
      'payment.refund.after': async (ctx, input, next) => {
        const result = await next();
        await store({
          action: 'payment.refund',
          requestId: ctx.meta.requestId,
          timestamp: ctx.meta.timestamp,
          input: sanitizeInput(input),
          output: sanitizeOutput(result),
          idempotencyKey: ctx.meta.idempotencyKey,
        });
        return result;
      },
    },
  };
}

interface AuditEntry {
  action: string;
  requestId: string;
  timestamp: Date;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  idempotencyKey?: string;
}

function sanitizeInput(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || !input) return {};
  const sanitized = { ...input } as Record<string, unknown>;
  // Remove sensitive fields
  delete sanitized.apiKey;
  delete sanitized.secretKey;
  delete sanitized.password;
  return sanitized;
}

function sanitizeOutput(output: unknown): Record<string, unknown> {
  if (typeof output !== 'object' || !output) return {};
  return { ...output } as Record<string, unknown>;
}

/**
 * Metrics plugin - collects operation metrics
 */
export function metricsPlugin(options: {
  onMetric?: (metric: Metric) => void;
} = {}): RevenuePlugin {
  const metrics: Metric[] = [];
  
  const record = options.onMetric ?? ((metric: Metric) => {
    metrics.push(metric);
  });

  return {
    name: 'metrics',
    version: '1.0.0',
    description: 'Collects operation metrics',
    hooks: {
      'payment.create.before': async (_ctx, input, next) => {
        const start = Date.now();
        try {
          const result = await next();
          record({
            name: 'payment.create',
            duration: Date.now() - start,
            success: true,
            amount: input.amount,
            currency: input.currency,
          });
          return result;
        } catch (error) {
          record({
            name: 'payment.create',
            duration: Date.now() - start,
            success: false,
            error: (error as Error).message,
          });
          throw error;
        }
      },
    },
  };
}

interface Metric {
  name: string;
  duration: number;
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

/**
 * Create a custom plugin
 */
export function definePlugin(plugin: RevenuePlugin): RevenuePlugin {
  return plugin;
}

export default PluginManager;

