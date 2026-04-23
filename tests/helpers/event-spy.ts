/**
 * Event Spy — captures events published via the shared Arc MemoryEventTransport.
 *
 * The spy subscribes to one or more event patterns before the scenario runs,
 * collects every event in insertion order, and exposes helpers for asserting
 * on the sequence. Intended for scenario-based integration tests that need to
 * prove "when the user does X, these events fire in this order."
 *
 * Subscribing happens on the shared `eventTransport` — the same transport the
 * `publish()` wrapper in `src/lib/events/arcEvents.ts` uses when no explicit
 * event API is set. For tests that boot the full Fastify app, the app's
 * event plugin will have installed an EventApi, so we subscribe via the same
 * wrapper to stay consistent with production.
 */

import type { DomainEvent } from '@classytic/arc/events';
import { subscribe } from '#lib/events/arcEvents.js';

export interface CapturedEvent<P = unknown> {
  type: string;
  payload: P;
  at: number;
}

export interface EventSpy {
  events: CapturedEvent[];
  types: () => string[];
  find: <P = unknown>(type: string) => CapturedEvent<P> | undefined;
  findAll: <P = unknown>(type: string) => CapturedEvent<P>[];
  count: (type: string) => number;
  clear: () => void;
  stop: () => Promise<void>;
  /**
   * Wait until the spy has captured at least one event of `type`, or until
   * `timeoutMs` elapses. Useful for async handlers that publish downstream
   * events (e.g. `accounting:order.fulfilled` → posting created).
   */
  waitFor: (type: string, timeoutMs?: number) => Promise<CapturedEvent | undefined>;
}

export async function startEventSpy(patterns: string[]): Promise<EventSpy> {
  const events: CapturedEvent[] = [];
  const unsubs: Array<() => void> = [];

  for (const pattern of patterns) {
    const unsub = await subscribe(pattern, async (event: DomainEvent) => {
      events.push({ type: event.type, payload: event.payload, at: Date.now() });
    });
    unsubs.push(unsub);
  }

  return {
    events,
    types: () => events.map((e) => e.type),
    find: <P>(type: string) => events.find((e) => e.type === type) as CapturedEvent<P> | undefined,
    findAll: <P>(type: string) => events.filter((e) => e.type === type) as CapturedEvent<P>[],
    count: (type: string) => events.filter((e) => e.type === type).length,
    clear: () => { events.length = 0; },
    stop: async () => { for (const u of unsubs) u(); },
    waitFor: async (type: string, timeoutMs = 2000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const hit = events.find((e) => e.type === type);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 25));
      }
      return undefined;
    },
  };
}

/**
 * Assert that `actual` contains `expected` types as a subsequence (in order,
 * but with other events allowed in between). This is the right default for
 * event sequences — we care about relative order, not absolute positions.
 */
export function expectSubsequence(actual: string[], expected: string[]): void {
  let i = 0;
  for (const a of actual) {
    if (a === expected[i]) i += 1;
    if (i === expected.length) return;
  }
  throw new Error(
    `Expected subsequence ${JSON.stringify(expected)} inside ${JSON.stringify(actual)}`,
  );
}
