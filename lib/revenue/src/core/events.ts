/**
 * Event System - Type-safe pub/sub
 * @classytic/revenue
 *
 * Strongly typed events with async handlers
 * Inspired by: Node.js EventEmitter, mitt, EventTarget
 */

import type { TransactionDocument, SubscriptionDocument } from '../types/index.js';
import type { PaymentResult, RefundResult } from '../providers/base.js';

// ============ EVENT DEFINITIONS ============

/**
 * All revenue events with their payload types
 */
export interface RevenueEvents {
  // Payment events
  'payment.initiated': PaymentInitiatedEvent;
  'payment.succeeded': PaymentSucceededEvent;
  'payment.failed': PaymentFailedEvent;
  'payment.refunded': PaymentRefundedEvent;
  
  // Subscription events
  'subscription.created': SubscriptionCreatedEvent;
  'subscription.activated': SubscriptionActivatedEvent;
  'subscription.renewed': SubscriptionRenewedEvent;
  'subscription.cancelled': SubscriptionCancelledEvent;
  'subscription.paused': SubscriptionPausedEvent;
  'subscription.resumed': SubscriptionResumedEvent;
  'subscription.expired': SubscriptionExpiredEvent;
  
  // Transaction events
  'transaction.created': TransactionCreatedEvent;
  'transaction.verified': TransactionVerifiedEvent;
  'transaction.completed': TransactionCompletedEvent;
  'transaction.failed': TransactionFailedEvent;
  
  // Escrow events
  'escrow.held': EscrowHeldEvent;
  'escrow.released': EscrowReleasedEvent;
  'escrow.cancelled': EscrowCancelledEvent;
  
  // Commission events
  'commission.calculated': CommissionCalculatedEvent;
  'commission.paid': CommissionPaidEvent;
  
  // Webhook events
  'webhook.received': WebhookReceivedEvent;
  'webhook.processed': WebhookProcessedEvent;
  
  // Wildcard - catches all events
  '*': BaseEvent;
}

// ============ EVENT PAYLOADS ============

export interface BaseEvent {
  readonly type: string;
  readonly timestamp: Date;
  readonly metadata?: Record<string, unknown>;
}

export interface PaymentInitiatedEvent extends BaseEvent {
  type: 'payment.initiated';
  transactionId: string;
  amount: number;
  currency: string;
  provider: string;
  intentId: string;
}

export interface PaymentSucceededEvent extends BaseEvent {
  type: 'payment.succeeded';
  transactionId: string;
  transaction: TransactionDocument;
  result: PaymentResult;
}

export interface PaymentFailedEvent extends BaseEvent {
  type: 'payment.failed';
  transactionId: string;
  error: Error;
  provider: string;
}

export interface PaymentRefundedEvent extends BaseEvent {
  type: 'payment.refunded';
  transactionId: string;
  result: RefundResult;
  amount: number;
  isPartial: boolean;
}

export interface SubscriptionCreatedEvent extends BaseEvent {
  type: 'subscription.created';
  subscriptionId: string;
  subscription: SubscriptionDocument;
  transactionId?: string;
}

export interface SubscriptionActivatedEvent extends BaseEvent {
  type: 'subscription.activated';
  subscriptionId: string;
  subscription: SubscriptionDocument;
  transactionId: string;
}

export interface SubscriptionRenewedEvent extends BaseEvent {
  type: 'subscription.renewed';
  subscriptionId: string;
  subscription: SubscriptionDocument;
  transactionId: string;
  period: { start: Date; end: Date };
}

export interface SubscriptionCancelledEvent extends BaseEvent {
  type: 'subscription.cancelled';
  subscriptionId: string;
  subscription: SubscriptionDocument;
  reason?: string;
  immediate: boolean;
}

export interface SubscriptionPausedEvent extends BaseEvent {
  type: 'subscription.paused';
  subscriptionId: string;
  subscription: SubscriptionDocument;
  resumeAt?: Date;
}

export interface SubscriptionResumedEvent extends BaseEvent {
  type: 'subscription.resumed';
  subscriptionId: string;
  subscription: SubscriptionDocument;
}

export interface SubscriptionExpiredEvent extends BaseEvent {
  type: 'subscription.expired';
  subscriptionId: string;
  subscription: SubscriptionDocument;
}

export interface TransactionCreatedEvent extends BaseEvent {
  type: 'transaction.created';
  transactionId: string;
  transaction: TransactionDocument;
}

export interface TransactionVerifiedEvent extends BaseEvent {
  type: 'transaction.verified';
  transactionId: string;
  transaction: TransactionDocument;
}

export interface TransactionCompletedEvent extends BaseEvent {
  type: 'transaction.completed';
  transactionId: string;
  transaction: TransactionDocument;
}

export interface TransactionFailedEvent extends BaseEvent {
  type: 'transaction.failed';
  transactionId: string;
  error: Error;
}

export interface EscrowHeldEvent extends BaseEvent {
  type: 'escrow.held';
  transactionId: string;
  amount: number;
  holdUntil?: Date;
}

export interface EscrowReleasedEvent extends BaseEvent {
  type: 'escrow.released';
  transactionId: string;
  releasedAmount: number;
  recipientId: string;
}

export interface EscrowCancelledEvent extends BaseEvent {
  type: 'escrow.cancelled';
  transactionId: string;
  reason: string;
}

export interface CommissionCalculatedEvent extends BaseEvent {
  type: 'commission.calculated';
  transactionId: string;
  grossAmount: number;
  netAmount: number;
  platformFee: number;
  gatewayFee: number;
}

export interface CommissionPaidEvent extends BaseEvent {
  type: 'commission.paid';
  transactionId: string;
  recipientId: string;
  amount: number;
}

export interface WebhookReceivedEvent extends BaseEvent {
  type: 'webhook.received';
  provider: string;
  eventType: string;
  payload: unknown;
}

export interface WebhookProcessedEvent extends BaseEvent {
  type: 'webhook.processed';
  provider: string;
  eventType: string;
  transactionId?: string;
  success: boolean;
}

// ============ EVENT BUS ============

type EventHandler<T> = (event: T) => void | Promise<void>;
type EventKey = keyof RevenueEvents;

/**
 * Type-safe event bus
 */
export class EventBus {
  private handlers = new Map<string, Set<EventHandler<any>>>();
  private onceHandlers = new Map<string, Set<EventHandler<any>>>();

  /**
   * Subscribe to an event
   */
  on<K extends EventKey>(
    event: K,
    handler: EventHandler<RevenueEvents[K]>
  ): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
    
    // Return unsubscribe function
    return () => this.off(event, handler);
  }

  /**
   * Subscribe to an event once
   */
  once<K extends EventKey>(
    event: K,
    handler: EventHandler<RevenueEvents[K]>
  ): () => void {
    if (!this.onceHandlers.has(event)) {
      this.onceHandlers.set(event, new Set());
    }
    this.onceHandlers.get(event)!.add(handler);
    
    return () => this.onceHandlers.get(event)?.delete(handler);
  }

  /**
   * Unsubscribe from an event
   */
  off<K extends EventKey>(
    event: K,
    handler: EventHandler<RevenueEvents[K]>
  ): void {
    this.handlers.get(event)?.delete(handler);
    this.onceHandlers.get(event)?.delete(handler);
  }

  /**
   * Emit an event (fire and forget, non-blocking)
   */
  emit<K extends EventKey>(event: K, payload: Omit<RevenueEvents[K], 'timestamp'>): void {
    const fullPayload = {
      ...payload,
      timestamp: new Date(),
    } as RevenueEvents[K];

    // Regular handlers
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        // Fire and forget - don't await
        Promise.resolve(handler(fullPayload)).catch(err => {
          console.error(`[Revenue] Event handler error for "${event}":`, err);
        });
      }
    }

    // Once handlers
    const onceHandlers = this.onceHandlers.get(event);
    if (onceHandlers) {
      for (const handler of onceHandlers) {
        Promise.resolve(handler(fullPayload)).catch(err => {
          console.error(`[Revenue] Once handler error for "${event}":`, err);
        });
      }
      this.onceHandlers.delete(event);
    }

    // Wildcard handlers
    if (event !== '*') {
      const wildcardHandlers = this.handlers.get('*');
      if (wildcardHandlers) {
        for (const handler of wildcardHandlers) {
          Promise.resolve(handler(fullPayload)).catch(err => {
            console.error(`[Revenue] Wildcard handler error:`, err);
          });
        }
      }
    }
  }

  /**
   * Emit and wait for all handlers to complete
   */
  async emitAsync<K extends EventKey>(
    event: K,
    payload: Omit<RevenueEvents[K], 'timestamp'>
  ): Promise<void> {
    const fullPayload = {
      ...payload,
      timestamp: new Date(),
    } as RevenueEvents[K];

    const promises: Promise<void>[] = [];

    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        promises.push(Promise.resolve(handler(fullPayload)));
      }
    }

    const onceHandlers = this.onceHandlers.get(event);
    if (onceHandlers) {
      for (const handler of onceHandlers) {
        promises.push(Promise.resolve(handler(fullPayload)));
      }
      this.onceHandlers.delete(event);
    }

    if (event !== '*') {
      const wildcardHandlers = this.handlers.get('*');
      if (wildcardHandlers) {
        for (const handler of wildcardHandlers) {
          promises.push(Promise.resolve(handler(fullPayload)));
        }
      }
    }

    await Promise.all(promises);
  }

  /**
   * Remove all handlers
   */
  clear(): void {
    this.handlers.clear();
    this.onceHandlers.clear();
  }

  /**
   * Get handler count for an event
   */
  listenerCount(event: EventKey): number {
    return (this.handlers.get(event)?.size ?? 0) + 
           (this.onceHandlers.get(event)?.size ?? 0);
  }
}

/**
 * Create a new event bus
 */
export function createEventBus(): EventBus {
  return new EventBus();
}

export default EventBus;

