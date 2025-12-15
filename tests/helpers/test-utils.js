/**
 * Test Utilities
 *
 * Common utilities for integration tests
 */

import { vi } from 'vitest';

/**
 * Wait for a condition to be true
 * Useful for testing async operations and event emissions
 */
export async function waitFor(condition, timeout = 5000, interval = 100) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  throw new Error(`Timeout waiting for condition after ${timeout}ms`);
}

/**
 * Create a spy for event emissions
 * Returns a promise that resolves when event is emitted
 */
export function createEventSpy(emitter, eventName) {
  return new Promise((resolve) => {
    const handler = (data) => {
      emitter.off(eventName, handler);
      resolve(data);
    };
    emitter.on(eventName, handler);
  });
}

/**
 * Mock external API calls
 */
export function mockRedXApi() {
  const originalFetch = global.fetch;

  const mock = vi.fn().mockImplementation((url, options) => {
    // Mock RedX API responses based on URL
    if (url.includes('/parcel')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          tracking_id: 'TRK-12345',
          message: 'Parcel created successfully',
        }),
      });
    }

    if (url.includes('/parcel/info/')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          parcel: {
            tracking_id: 'TRK-12345',
            status: 'delivered',
            customer_name: 'John Doe',
            customer_phone: '01712345678',
            customer_address: 'Test Address',
            delivery_area: 'Mohammadpur',
            delivery_area_id: 1,
            cash_collection_amount: '2000',
            parcel_weight: 500,
            value: 2000,
            merchant_invoice_id: 'ORD-123',
            created_at: new Date().toISOString(),
            charge: 60,
          },
        }),
      });
    }

    if (url.includes('/parcel/track/')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          tracking: [
            {
              message_en: 'Parcel created',
              message_bn: 'পার্সেল তৈরি হয়েছে',
              time: new Date().toISOString(),
            },
            {
              message_en: 'Parcel delivered',
              message_bn: 'পার্সেল ডেলিভার হয়েছে',
              time: new Date().toISOString(),
            },
          ],
        }),
      });
    }

    return originalFetch(url, options);
  });

  global.fetch = mock;

  return {
    restore: () => {
      global.fetch = originalFetch;
    },
    mock,
  };
}

/**
 * Capture console output for assertions
 */
export function captureConsole() {
  const logs = { error: [], warn: [], info: [], log: [] };
  const originalConsole = {
    error: console.error,
    warn: console.warn,
    info: console.info,
    log: console.log,
  };

  console.error = (...args) => logs.error.push(args);
  console.warn = (...args) => logs.warn.push(args);
  console.info = (...args) => logs.info.push(args);
  console.log = (...args) => logs.log.push(args);

  return {
    logs,
    restore: () => {
      console.error = originalConsole.error;
      console.warn = originalConsole.warn;
      console.info = originalConsole.info;
      console.log = originalConsole.log;
    },
  };
}

/**
 * Wait for multiple events
 */
export async function waitForEvents(emitter, eventNames, timeout = 5000) {
  const promises = eventNames.map(eventName => createEventSpy(emitter, eventName));

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Timeout waiting for events: ${eventNames.join(', ')}`)), timeout);
  });

  return Promise.race([
    Promise.all(promises),
    timeoutPromise,
  ]);
}

/**
 * Sleep helper
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a mock MongoDB transaction session
 */
export function createMockSession() {
  let aborted = false;
  let committed = false;

  return {
    startTransaction: () => {},
    commitTransaction: () => { committed = true; },
    abortTransaction: () => { aborted = true; },
    endSession: () => {},
    isCommitted: () => committed,
    isAborted: () => aborted,
  };
}
