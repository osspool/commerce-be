import { EventOutbox, exponentialBackoff } from '@classytic/arc/events';
import { eventTransport } from '#lib/events/EventBus.js';
import { MongoOutboxStore } from './mongo-outbox-store.js';

const store = new MongoOutboxStore();
export const outbox = new EventOutbox({
  store,
  transport: eventTransport,
  failurePolicy: ({ attempts, error }) => {
    if (attempts >= 5) return { deadLetter: true };
    return { retryAt: exponentialBackoff({ attempt: attempts, baseMs: 5_000, maxMs: 300_000 }) };
  },
});
export { store as outboxStore };
