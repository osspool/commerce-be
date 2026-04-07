import { EventOutbox } from '@classytic/arc/events';
import { MongoOutboxStore } from './mongo-outbox-store.js';
import { eventTransport } from '#lib/events/EventBus.js';

const store = new MongoOutboxStore();
export const outbox = new EventOutbox({ store, transport: eventTransport });
export { store as outboxStore };
