/**
 * Central Event Registry
 *
 * All domain events are registered here for catalog introspection
 * and optional schema validation on publish.
 *
 * Pass this registry to the eventPlugin options:
 *   await fastify.register(eventPlugin, { registry: eventRegistry, validateMode: 'warn' });
 */

import { createEventRegistry } from '@classytic/arc/events';

export const eventRegistry = createEventRegistry();
