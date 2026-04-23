import type { DomainEvent, EventHandler } from '@classytic/arc/events';
import { createEvent } from '@classytic/arc/events';
import { eventTransport } from './EventBus.js';

interface EventApi {
  publish(type: string, payload: unknown, meta?: Partial<DomainEvent['meta']>): Promise<void>;
  subscribe(pattern: string, handler: EventHandler): Promise<() => void>;
}

let eventApi: EventApi | null = null;

export function setEventApi(api: EventApi | null): void {
  eventApi = api || null;
}

export function clearEventApi(): void {
  eventApi = null;
}

export function publish(type: string, payload: unknown, meta?: Partial<DomainEvent['meta']>): Promise<void> {
  if (eventApi?.publish) {
    return eventApi.publish(type, payload, meta);
  }

  return eventTransport.publish(createEvent(type, payload, meta));
}

export function subscribe(pattern: string, handler: EventHandler): Promise<() => void> {
  if (eventApi?.subscribe) {
    return eventApi.subscribe(pattern, handler);
  }

  return eventTransport.subscribe(pattern, handler);
}
