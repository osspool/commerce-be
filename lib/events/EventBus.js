import { MemoryEventTransport } from '@classytic/arc/events';

// Shared Arc transport (used by fastify eventPlugin + arcEvents)
export const eventTransport = new MemoryEventTransport();
