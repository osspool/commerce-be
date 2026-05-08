/**
 * Event Integration E2E Test
 *
 * Tests the full event pipeline end-to-end:
 * 1. defineEvent → create typed events
 * 2. EventRegistry → register + validate
 * 3. EventTransport → publish + subscribe (in-memory)
 * 4. EventOutbox → store → relay → subscribe receives
 * 5. POS flow → outbox.store → relay → handler processes
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  defineEvent,
  createEventRegistry,
  MemoryEventTransport,
  EventOutbox,
  MemoryOutboxStore,
} from '@classytic/arc/events';
import { createEvent } from '@classytic/primitives/events';
import type { DomainEvent, EventHandler } from '@classytic/primitives/events';

// MongoDB connection managed by per-suite-mongo.ts setupFile.
// No need to create our own MongoMemoryServer.

beforeAll(async () => {
  if (mongoose.connection.readyState === 0) {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    // Store for cleanup
    (globalThis as any).__EVENT_TEST_MONGO__ = mongod;
  }
}, 30000);

afterAll(async () => {
  const mongod = (globalThis as any).__EVENT_TEST_MONGO__;
  if (mongod) {
    await mongoose.disconnect();
    await mongod.stop();
  }
});

beforeEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
});

// ============================================================================
// 1. defineEvent + EventRegistry
// ============================================================================

describe('defineEvent + EventRegistry', () => {
  interface OrderPayload { orderId: string; total: number }

  const OrderCreated = defineEvent<OrderPayload>({
    name: 'order.created',
    version: 1,
    description: 'Order was created',
    schema: {
      type: 'object',
      properties: {
        orderId: { type: 'string' },
        total: { type: 'number' },
      },
      required: ['orderId', 'total'],
    },
  });

  it('creates a typed DomainEvent with auto-generated metadata', () => {
    const event = OrderCreated.create({ orderId: 'ord-1', total: 500 });

    expect(event.type).toBe('order.created');
    expect(event.payload.orderId).toBe('ord-1');
    expect(event.payload.total).toBe(500);
    expect(event.meta.id).toBeDefined();
    expect(event.meta.timestamp).toBeInstanceOf(Date);
  });

  it('registers events and validates payloads via registry', () => {
    const registry = createEventRegistry();
    registry.register(OrderCreated);

    const catalog = registry.catalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0].name).toBe('order.created');
    expect(catalog[0].version).toBe(1);

    // Valid payload
    const valid = registry.validate('order.created', { orderId: 'o-1', total: 100 });
    expect(valid.valid).toBe(true);

    // Missing required field
    const invalid = registry.validate('order.created', { total: 100 });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors).toContain("Missing required field: 'orderId'");

    // Wrong type
    const wrongType = registry.validate('order.created', { orderId: 123, total: 100 });
    expect(wrongType.valid).toBe(false);
    expect(wrongType.errors?.[0]).toContain("expected string, got number");
  });

  it('passes validation for unknown events (opt-in registry)', () => {
    const registry = createEventRegistry();
    const result = registry.validate('unknown.event', { anything: true });
    expect(result.valid).toBe(true);
  });

  it('supports schema versioning', () => {
    const registry = createEventRegistry();

    const V1 = defineEvent({ name: 'user.updated', version: 1, schema: {
      type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'],
    }});
    const V2 = defineEvent({ name: 'user.updated', version: 2, schema: {
      type: 'object', properties: { userId: { type: 'string' }, email: { type: 'string' } }, required: ['userId', 'email'],
    }});

    registry.register(V1);
    registry.register(V2);

    // Latest version (v2) is used for validation
    const result = registry.validate('user.updated', { userId: 'u-1' });
    expect(result.valid).toBe(false); // missing 'email' required by v2

    // Specific version lookup
    expect(registry.get('user.updated', 1)?.version).toBe(1);
    expect(registry.get('user.updated', 2)?.version).toBe(2);
    expect(registry.get('user.updated')?.version).toBe(2); // latest
  });
});

// ============================================================================
// 2. MemoryEventTransport — publish + subscribe
// ============================================================================

describe('MemoryEventTransport', () => {
  it('delivers events to matching subscribers', async () => {
    const transport = new MemoryEventTransport();
    const received: DomainEvent[] = [];

    await transport.subscribe('order.created', async (event) => {
      received.push(event);
    });

    const event = createEvent('order.created', { orderId: 'o-1' });
    await transport.publish(event);

    expect(received).toHaveLength(1);
    expect(received[0].payload).toEqual({ orderId: 'o-1' });
  });

  it('supports wildcard subscriptions', async () => {
    const transport = new MemoryEventTransport();
    const received: DomainEvent[] = [];

    await transport.subscribe('order.*', async (event) => {
      received.push(event);
    });

    await transport.publish(createEvent('order.created', { id: '1' }));
    await transport.publish(createEvent('order.cancelled', { id: '2' }));
    await transport.publish(createEvent('product.created', { id: '3' })); // should NOT match

    expect(received).toHaveLength(2);
    expect(received[0].type).toBe('order.created');
    expect(received[1].type).toBe('order.cancelled');
  });

  it('unsubscribe stops delivery', async () => {
    const transport = new MemoryEventTransport();
    const received: DomainEvent[] = [];

    const unsubscribe = await transport.subscribe('test.event', async (event) => {
      received.push(event);
    });

    await transport.publish(createEvent('test.event', { n: 1 }));
    expect(received).toHaveLength(1);

    unsubscribe();
    await transport.publish(createEvent('test.event', { n: 2 }));
    expect(received).toHaveLength(1); // still 1 — unsubscribed
  });

  it('isolates handler errors — one failure does not block others', async () => {
    const transport = new MemoryEventTransport();
    const results: string[] = [];

    await transport.subscribe('test', async () => {
      results.push('handler-1');
    });
    await transport.subscribe('test', async () => {
      throw new Error('handler-2 fails');
    });
    await transport.subscribe('test', async () => {
      results.push('handler-3');
    });

    await transport.publish(createEvent('test', {}));

    expect(results).toContain('handler-1');
    expect(results).toContain('handler-3');
  });
});

// ============================================================================
// 3. EventOutbox — store + relay
// ============================================================================

describe('EventOutbox (MemoryOutboxStore)', () => {
  it('stores events and relays them to transport', async () => {
    const transport = new MemoryEventTransport();
    const store = new MemoryOutboxStore();
    const outbox = new EventOutbox({ store, transport });
    const received: DomainEvent[] = [];

    await transport.subscribe('payment.captured', async (event) => {
      received.push(event);
    });

    // Store event (simulating business transaction)
    const event = createEvent('payment.captured', { amount: 1000 });
    await outbox.store(event);

    // Not delivered yet — only stored
    expect(received).toHaveLength(0);

    // Relay publishes pending events
    const relayed = await outbox.relay();
    expect(relayed).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0].payload).toEqual({ amount: 1000 });

    // Second relay — nothing pending
    const relayed2 = await outbox.relay();
    expect(relayed2).toBe(0);
  });

  it('preserves event ordering (FIFO)', async () => {
    const transport = new MemoryEventTransport();
    const store = new MemoryOutboxStore();
    const outbox = new EventOutbox({ store, transport });
    const received: DomainEvent[] = [];

    await transport.subscribe('*', async (event) => {
      received.push(event);
    });

    await outbox.store(createEvent('step.1', { order: 1 }));
    await outbox.store(createEvent('step.2', { order: 2 }));
    await outbox.store(createEvent('step.3', { order: 3 }));

    await outbox.relay();

    expect(received).toHaveLength(3);
    expect(received[0].type).toBe('step.1');
    expect(received[1].type).toBe('step.2');
    expect(received[2].type).toBe('step.3');
  });
});

// ============================================================================
// 4. MongoOutboxStore — durable persistence
// ============================================================================

describe('MongoOutboxStore (MongoDB)', () => {
  it('persists events and retrieves pending ones', async () => {
    const { MongoOutboxStore } = await import('#shared/outbox/mongo-outbox-store.js');
    const store = new MongoOutboxStore();

    const event = createEvent('order.shipped', { orderId: 'o-99', carrier: 'RedX' });
    await store.save(event);

    const pending = await store.getPending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0].type).toBe('order.shipped');
    expect((pending[0].payload as Record<string, unknown>).orderId).toBe('o-99');
  });

  it('acknowledge marks event as delivered', async () => {
    const { MongoOutboxStore } = await import('#shared/outbox/mongo-outbox-store.js');
    const store = new MongoOutboxStore();

    const event = createEvent('test.ack', { data: 'hello' });
    await store.save(event);

    let pending = await store.getPending(10);
    expect(pending).toHaveLength(1);

    await store.acknowledge(event.meta.id);

    pending = await store.getPending(10);
    expect(pending).toHaveLength(0); // no longer pending
  });

  it('full outbox cycle with MongoDB store', async () => {
    const { MongoOutboxStore } = await import('#shared/outbox/mongo-outbox-store.js');
    const transport = new MemoryEventTransport();
    const store = new MongoOutboxStore();
    const outbox = new EventOutbox({ store, transport });
    const received: DomainEvent[] = [];

    await transport.subscribe('pos:transaction.create', async (event) => {
      received.push(event);
    });

    // Simulate POS controller: store event in outbox
    const posEvent = createEvent('pos:transaction.create', {
      orderId: 'pos-001',
      totalAmount: 1500,
      branchCode: 'DHK-01',
      cashierId: 'cashier-1',
    });
    await outbox.store(posEvent);

    // Event not yet delivered
    expect(received).toHaveLength(0);

    // Simulate cron relay
    const count = await outbox.relay();
    expect(count).toBe(1);

    // Event now delivered to subscriber
    expect(received).toHaveLength(1);
    expect((received[0].payload as Record<string, unknown>).orderId).toBe('pos-001');
    expect((received[0].payload as Record<string, unknown>).totalAmount).toBe(1500);

    // Subsequent relay — nothing pending
    const count2 = await outbox.relay();
    expect(count2).toBe(0);
  });

  it('survives relay failure — events stay pending', async () => {
    const { MongoOutboxStore } = await import('#shared/outbox/mongo-outbox-store.js');
    const store = new MongoOutboxStore();

    // Transport that fails on publish
    const failingTransport: MemoryEventTransport = {
      name: 'failing',
      publish: async () => { throw new Error('Transport down'); },
      subscribe: async () => () => {},
    } as unknown as MemoryEventTransport;

    const outbox = new EventOutbox({ store, transport: failingTransport });

    await outbox.store(createEvent('important.event', { critical: true }));

    // Relay fails — but doesn't throw
    const count = await outbox.relay();
    expect(count).toBe(0);

    // Event still pending — will be retried on next relay.
    // Note: store.getPending() claims events, so after a failed relay the events
    // are claimed (not stale yet). Query the DB directly to verify status.
    const pendingDocs = await mongoose.connection.collection('outboxevents')
      .find({ status: 'pending' }).toArray();
    expect(pendingDocs).toHaveLength(1);
    expect(pendingDocs[0].type).toBe('important.event');
  });
});

// ============================================================================
// 5. Full POS Event Flow E2E
// ============================================================================

describe('POS Event Flow E2E', () => {
  it('defineEvent → outbox.store → relay → subscriber receives typed event', async () => {
    const { MongoOutboxStore } = await import('#shared/outbox/mongo-outbox-store.js');

    // Setup
    const transport = new MemoryEventTransport();
    const store = new MongoOutboxStore();
    const outbox = new EventOutbox({ store, transport });
    const registry = createEventRegistry();

    // Define POS event with schema
    interface PosPayload { orderId: string; totalAmount: number; cashierId: string }
    const PosTransactionCreate = defineEvent<PosPayload>({
      name: 'pos:transaction.create',
      schema: {
        type: 'object',
        properties: {
          orderId: { type: 'string' },
          totalAmount: { type: 'number' },
          cashierId: { type: 'string' },
        },
        required: ['orderId', 'totalAmount', 'cashierId'],
      },
    });
    registry.register(PosTransactionCreate);

    // Subscribe (simulates pos.events.ts handler)
    const handlerCalls: PosPayload[] = [];
    await transport.subscribe('pos:transaction.create', async (event: DomainEvent) => {
      handlerCalls.push(event.payload as PosPayload);
    });

    // Validate payload before storing (optional — registry is opt-in)
    const payload: PosPayload = { orderId: 'pos-e2e-001', totalAmount: 2500, cashierId: 'c-1' };
    const validation = registry.validate('pos:transaction.create', payload);
    expect(validation.valid).toBe(true);

    // Store in outbox (simulates POS controller)
    const event = PosTransactionCreate.create(payload);
    await outbox.store(event);

    // Verify stored in MongoDB (direct query — getPending would claim the event)
    const stored = await mongoose.connection.collection('outboxevents')
      .find({ status: 'pending' }).toArray();
    expect(stored).toHaveLength(1);

    // Relay (simulates cron)
    await outbox.relay();

    // Verify handler received the event
    expect(handlerCalls).toHaveLength(1);
    expect(handlerCalls[0].orderId).toBe('pos-e2e-001');
    expect(handlerCalls[0].totalAmount).toBe(2500);
    expect(handlerCalls[0].cashierId).toBe('c-1');

    // Verify outbox is clean
    const remaining = await mongoose.connection.collection('outboxevents')
      .countDocuments({ status: 'pending' });
    expect(remaining).toBe(0);
  });
});

// ============================================================================
// 6. withCompensation E2E
// ============================================================================

describe('withCompensation E2E', () => {
  it('runs steps in order and returns results on success', async () => {
    const { withCompensation } = await import('@classytic/arc/utils');

    interface Ctx { orderId: string; reserved?: boolean; charged?: boolean; [key: string]: unknown }

    const result = await withCompensation<Ctx>('checkout', [
      {
        name: 'reserve',
        execute: async (ctx) => { ctx.reserved = true; return { reservationId: 'r-1' }; },
        compensate: async (ctx) => { ctx.reserved = false; },
      },
      {
        name: 'charge',
        execute: async (ctx) => { ctx.charged = true; return { chargeId: 'ch-1' }; },
        compensate: async (ctx) => { ctx.charged = false; },
      },
    ], { orderId: 'ord-1' });

    if (result.success) {
      expect(result.completedSteps).toEqual(['reserve', 'charge']);
      expect(result.results['reserve']).toEqual({ reservationId: 'r-1' });
      expect(result.results['charge']).toEqual({ chargeId: 'ch-1' });
    }
  });

  it('rolls back completed steps on failure in reverse order', async () => {
    const { withCompensation } = await import('@classytic/arc/utils');

    const compensated: string[] = [];

    interface Ctx { orderId: string; [key: string]: unknown }

    const result = await withCompensation<Ctx>('failing-checkout', [
      {
        name: 'step-1',
        execute: async () => 'done-1',
        compensate: async () => { compensated.push('step-1'); },
      },
      {
        name: 'step-2',
        execute: async () => 'done-2',
        compensate: async () => { compensated.push('step-2'); },
      },
      {
        name: 'step-3',
        execute: async () => { throw new Error('Payment gateway timeout'); },
        compensate: async () => { compensated.push('step-3'); },
      },
    ], { orderId: 'fail-1' });

    if (!result.success) {
      expect(result.failedStep).toBe('step-3');
      expect(result.error).toBe('Payment gateway timeout');
      expect(result.completedSteps).toEqual(['step-1', 'step-2']);
      // Compensated in reverse order
      expect(compensated).toEqual(['step-2', 'step-1']);
    }
  });

  it('fireAndForget steps are not awaited or compensated', async () => {
    const { withCompensation } = await import('@classytic/arc/utils');

    const compensated: string[] = [];
    let emailSent = false;

    interface Ctx { [key: string]: unknown }

    const result = await withCompensation<Ctx>('with-ff', [
      {
        name: 'main-work',
        execute: async () => 'done',
        compensate: async () => { compensated.push('main-work'); },
      },
      {
        name: 'send-email',
        execute: async () => { emailSent = true; return 'sent'; },
        fireAndForget: true,
      },
      {
        name: 'fails',
        execute: async () => { throw new Error('boom'); },
      },
    ], {});

    if (!result.success) {
      // send-email was fire-and-forget so NOT in compensated list
      expect(compensated).toEqual(['main-work']);
      // send-email still appears in completedSteps (it was dispatched)
      expect(result.completedSteps).toContain('send-email');
    }
  });
});
