import { EventOutbox } from '@classytic/arc/events';
import { eventTransport } from '#lib/events/EventBus.js';
import { MongoOutboxStore } from './mongo-outbox-store.js';

const store = new MongoOutboxStore();
export const outbox = new EventOutbox({ store, transport: eventTransport });
export { store as outboxStore };
