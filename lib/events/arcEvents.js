import { createEvent } from '@classytic/arc/events';
import { eventTransport } from './EventBus.js';

let eventApi = null;

export function setEventApi(api) {
  eventApi = api || null;
}

export function clearEventApi() {
  eventApi = null;
}

export function publish(type, payload, meta) {
  if (eventApi?.publish) {
    return eventApi.publish(type, payload, meta);
  }

  return eventTransport.publish(createEvent(type, payload, meta));
}

export function subscribe(pattern, handler) {
  if (eventApi?.subscribe) {
    return eventApi.subscribe(pattern, handler);
  }

  return eventTransport.subscribe(pattern, handler);
}
