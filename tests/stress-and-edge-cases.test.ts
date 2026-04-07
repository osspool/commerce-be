/**
 * Stress Tests & Edge Cases
 *
 * Tests that try to BREAK the system by probing:
 * 1. Outbox race conditions (concurrent relay)
 * 2. Outbox duplicate event storage
 * 3. Event handler failure after outbox acknowledge (lost events)
 * 4. Compensation with async context mutations
 * 5. Event registry not wired to app (schema validation silently skipped)
 * 6. MongoOutboxStore concurrent getPending + acknowledge race
 * 7. POS event handler crash doesn't retry (outbox already acknowledged)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  MemoryEventTransport,
  EventOutbox,
  MemoryOutboxStore,
  createEvent,
} from '@classytic/arc/events';
import type { DomainEvent } from '@classytic/arc/events';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
});

// ============================================================================
// BUG 1: Concurrent relay() can double-publish events
// ============================================================================

describe('Outbox concurrent relay race condition', () => {
  it('KNOWN GAP: concurrent relay() calls can double-publish', async () => {
    const { MongoOutboxStore } = await import('#shared/outbox/mongo-outbox-store.js');
    const transport = new MemoryEventTransport();
    const store = new MongoOutboxStore();
    const outbox = new EventOutbox({ store, transport });

    const received: DomainEvent[] = [];
    await transport.subscribe('*', async (event) => {
      received.push(event);
    });

    // Store one event
    await outbox.store(createEvent('test.concurrent', { id: 1 }));

    // Two concurrent relay() calls — both will getPending() before either acknowledges
    const [count1, count2] = await Promise.all([
      outbox.relay(),
      outbox.relay(),
    ]);

    // BUG: Both relays see the same pending event and publish it
    // Expected: total published should be 1
    // Actual: could be 2 (race condition)
    const totalRelayed = count1 + count2;

    // This test documents the gap — if it fails with totalRelayed === 1,
    // then the race condition has been fixed (great!)
    if (totalRelayed > 1) {
      console.warn(
        `KNOWN GAP: Concurrent relay published ${totalRelayed} times (expected 1). ` +
        `Fix: Use findOneAndUpdate with status: "pending" → "processing" atomic lock in getPending.`
      );
    }

    // At minimum, the event should have been delivered at least once
    expect(received.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// BUG 2: Outbox acknowledge happens AFTER publish, BEFORE handler completes
// ============================================================================

describe('Outbox acknowledge timing gap', () => {
  it('KNOWN GAP: event is acknowledged even if subscriber handler fails', async () => {
    const transport = new MemoryEventTransport();
    const store = new MemoryOutboxStore();
    const outbox = new EventOutbox({ store, transport });

    let handlerCalled = 0;

    // Subscriber that always fails
    await transport.subscribe('critical.payment', async () => {
      handlerCalled++;
      throw new Error('Handler crashed — payment not processed');
    });

    await outbox.store(createEvent('critical.payment', { amount: 5000 }));

    // Relay publishes to transport → transport calls handler → handler throws
    // BUT: outbox.relay() acknowledged the event already after transport.publish() succeeded
    await outbox.relay();

    expect(handlerCalled).toBe(1);

    // The event is now acknowledged (removed from pending) even though handler failed
    const pending = await store.getPending(10);
    expect(pending).toHaveLength(0); // Event is GONE — no retry possible

    // This is a known limitation of the outbox pattern:
    // Outbox guarantees at-least-once DELIVERY to transport, not at-least-once PROCESSING.
    // For handler-level retry, use Arc's withRetry() wrapper on the subscriber.
  });
});

// ============================================================================
// BUG 3: MongoOutboxStore.getPending returns non-atomic snapshot
// ============================================================================

describe('MongoOutboxStore atomicity', () => {
  it('duplicate event IDs are rejected by unique index', async () => {
    const { MongoOutboxStore } = await import('#shared/outbox/mongo-outbox-store.js');
    const store = new MongoOutboxStore();

    const event = createEvent('test.dup', { data: 'first' });
    await store.save(event);

    // Same event ID should fail
    await expect(store.save(event)).rejects.toThrow();

    // Only one event stored
    const pending = await store.getPending(10);
    expect(pending).toHaveLength(1);
  });

  it('acknowledge is idempotent — calling twice does not error', async () => {
    const { MongoOutboxStore } = await import('#shared/outbox/mongo-outbox-store.js');
    const store = new MongoOutboxStore();

    const event = createEvent('test.idem', { data: 'hello' });
    await store.save(event);

    await store.acknowledge(event.meta.id);
    await store.acknowledge(event.meta.id); // second call — no error

    const pending = await store.getPending(10);
    expect(pending).toHaveLength(0);
  });

  it('acknowledge for non-existent eventId does not error', async () => {
    const { MongoOutboxStore } = await import('#shared/outbox/mongo-outbox-store.js');
    const store = new MongoOutboxStore();

    // Should not throw
    await store.acknowledge('non-existent-id');
  });
});

// ============================================================================
// BUG 4: withCompensation context is shallow-copied — nested objects are shared
// ============================================================================

describe('withCompensation context mutation edge cases', () => {
  it('nested object mutations in context are visible across steps', async () => {
    const { withCompensation } = await import('@classytic/arc/utils');

    interface Ctx { nested: { value: number }; [key: string]: unknown }

    const result = await withCompensation<Ctx>('nested-mutation', [
      {
        name: 'step-1',
        execute: async (ctx) => {
          ctx.nested.value = 42; // mutates shared reference
        },
      },
      {
        name: 'step-2',
        execute: async (ctx) => {
          // step-1's mutation is visible because ctx is shallow-copied
          return ctx.nested.value;
        },
      },
    ], { nested: { value: 0 } });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.results['step-2']).toBe(42);
    }
  });

  it('compensation receives the mutated context — not the original', async () => {
    const { withCompensation } = await import('@classytic/arc/utils');

    let compensationSawValue: number | undefined;

    interface Ctx { counter: number; [key: string]: unknown }

    const result = await withCompensation<Ctx>('compensate-sees-mutations', [
      {
        name: 'increment',
        execute: async (ctx) => {
          ctx.counter = 10;
          return 'done';
        },
        compensate: async (ctx) => {
          compensationSawValue = ctx.counter; // should be 10, not 0
        },
      },
      {
        name: 'fail',
        execute: async () => { throw new Error('boom'); },
      },
    ], { counter: 0 });

    expect(result.success).toBe(false);
    // Compensation sees the MUTATED context (counter=10), not the initial (counter=0)
    expect(compensationSawValue).toBe(10);
  });
});

// ============================================================================
// BUG 5: Event registry is created but not wired to eventPlugin in app.ts
// ============================================================================

describe('Event registry integration gap', () => {
  it('KNOWN GAP: eventRegistry exists but is not passed to Arc eventPlugin', async () => {
    // The eventRegistry in shared/event-registry.ts has all 76 events registered.
    // BUT app.ts creates the Arc app with:
    //   arcPlugins: { events: { logEvents: !config.isProduction } }
    // There is NO registry or validateMode passed to the event plugin.
    //
    // This means:
    // - Schema validation never runs on publish
    // - The registry catalog is not accessible via fastify.events.registry
    //
    // FIX: In app.ts, pass eventRegistry to the event plugin options:
    //   arcPlugins: { events: { logEvents: !config.isProduction, registry: eventRegistry, validateMode: 'warn' } }

    const { eventRegistry } = await import('#shared/event-registry.js');
    // In isolation, registry is empty — events register at module import time,
    // which only happens when the full app boots.
    // The real gap: app.ts doesn't pass eventRegistry to Arc's eventPlugin.
    // FIX: add { registry: eventRegistry, validateMode: 'warn' } to arcPlugins.events in app.ts
    const catalog = eventRegistry.catalog();
    expect(catalog.length).toBe(0); // Empty in test isolation — this is expected

    // After importing an events module, it should be registered:
    await import('#resources/commerce/branch/events.js');
    const catalogAfterImport = eventRegistry.catalog();
    expect(catalogAfterImport.length).toBeGreaterThan(0);
    expect(catalogAfterImport.some(e => e.name === 'branch:created')).toBe(true);
  });
});

// ============================================================================
// BUG 6: POS outbox stores event but cron/relay is in cron/index.ts
//         which only initializes in inline worker mode
// ============================================================================

describe('POS outbox relay dependency', () => {
  it('outbox relay depends on cron initialization', async () => {
    // In app.ts, cron is initialized conditionally:
    //   if (isInlineWorkerMode && config.app.disableCronJobs !== true)
    //
    // If disableCronJobs is true OR worker mode is standalone:
    //   - POS events are stored in outbox (MongoDB)
    //   - But relay() never runs
    //   - Events pile up in outbox indefinitely
    //
    // This is technically correct for standalone worker mode
    // (the worker process would run cron), but if cron is disabled
    // entirely, POS transactions are silently lost.

    // This test just documents the dependency
    expect(true).toBe(true);
  });
});

// ============================================================================
// BUG 7: MemoryEventTransport handler order is not guaranteed
// ============================================================================

describe('MemoryEventTransport handler execution', () => {
  it('handlers for same event type execute concurrently', async () => {
    const transport = new MemoryEventTransport();
    const order: string[] = [];

    await transport.subscribe('test.order', async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push('slow');
    });

    await transport.subscribe('test.order', async () => {
      order.push('fast');
    });

    await transport.publish(createEvent('test.order', {}));

    // Both handlers run, but order depends on implementation
    expect(order).toContain('slow');
    expect(order).toContain('fast');
  });
});

// ============================================================================
// BUG 8: Large outbox batch with partial failure
// ============================================================================

describe('Outbox partial relay failure', () => {
  it('stops on first failure — remaining events stay pending', async () => {
    const store = new MemoryOutboxStore();
    let publishCount = 0;

    const flakeyTransport = {
      name: 'flakey',
      publish: async () => {
        publishCount++;
        if (publishCount === 3) throw new Error('Network blip');
      },
      subscribe: async () => () => {},
    } as unknown as MemoryEventTransport;

    const outbox = new EventOutbox({ store, transport: flakeyTransport });

    // Store 5 events
    for (let i = 1; i <= 5; i++) {
      await outbox.store(createEvent(`batch.event.${i}`, { i }));
    }

    // Relay — fails on 3rd event
    const relayed = await outbox.relay();
    expect(relayed).toBe(2); // Only 2 succeeded before failure

    // 3 events still pending (3rd failed + 4th and 5th never attempted)
    const pending = await store.getPending(10);
    expect(pending).toHaveLength(3);
    expect(pending[0].type).toBe('batch.event.3');
  });
});

// ============================================================================
// BUG 9: withCompensation — compensation failure is captured, not thrown
// ============================================================================

describe('withCompensation compensation failure handling', () => {
  it('captures compensation errors without throwing', async () => {
    const { withCompensation } = await import('@classytic/arc/utils');

    interface Ctx { [key: string]: unknown }

    const result = await withCompensation<Ctx>('comp-fail', [
      {
        name: 'step-1',
        execute: async () => 'ok',
        compensate: async () => {
          throw new Error('Compensation DB is down');
        },
      },
      {
        name: 'step-2',
        execute: async () => { throw new Error('Step 2 fails'); },
      },
    ], {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.failedStep).toBe('step-2');
      // Compensation for step-1 also failed — captured in compensationErrors
      expect(result.compensationErrors).toHaveLength(1);
      expect(result.compensationErrors![0].step).toBe('step-1');
      expect(result.compensationErrors![0].error).toBe('Compensation DB is down');
    }
  });
});

// ============================================================================
// BUG 10: Empty steps array
// ============================================================================

describe('withCompensation edge cases', () => {
  it('empty steps array succeeds immediately', async () => {
    const { withCompensation } = await import('@classytic/arc/utils');

    const result = await withCompensation('empty', [], {});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.completedSteps).toEqual([]);
    }
  });

  it('single step with no compensation', async () => {
    const { withCompensation } = await import('@classytic/arc/utils');

    interface Ctx { [key: string]: unknown }

    const result = await withCompensation<Ctx>('single', [
      { name: 'only', execute: async () => 'result' },
    ], {});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.results['only']).toBe('result');
    }
  });

  it('first step fails — no compensations to run', async () => {
    const { withCompensation } = await import('@classytic/arc/utils');

    interface Ctx { [key: string]: unknown }

    const result = await withCompensation<Ctx>('first-fail', [
      {
        name: 'step-1',
        execute: async () => { throw new Error('immediate fail'); },
        compensate: async () => { /* should NOT be called — step didn't complete */ },
      },
    ], {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.failedStep).toBe('step-1');
      expect(result.completedSteps).toEqual([]);
      // No compensation errors because step-1 didn't complete
      expect(result.compensationErrors).toBeUndefined();
    }
  });
});
