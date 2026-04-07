/**
 * Arc Event Adapter — bridges Flow domain events to Arc's event system.
 *
 * Flow emits events like 'inventory.move.done' on its internal bus.
 * This adapter forwards them to Arc's app.events.publish() so they
 * reach Redis, SSE, WebSocket subscribers, and other modules.
 */
import { FlowEvents } from '@classytic/flow';
import type { FlowEngine } from '@classytic/flow';

interface ArcEventsApi {
  publish(event: string, data: unknown): Promise<void>;
}

let arcEventsApi: ArcEventsApi | null = null;

/**
 * Set the Arc events API (called once at app startup after Arc events plugin registers).
 */
export function setArcEventsApi(eventsApi: ArcEventsApi): void {
  arcEventsApi = eventsApi;
}

/**
 * Bridge all Flow events to Arc.
 * Call this once after FlowEngine is created.
 */
export function bridgeFlowEvents(flowEngine: FlowEngine): void {
  const forward = (flowEvent: string): void => {
    flowEngine.events.on(flowEvent, async (data: unknown) => {
      if (arcEventsApi) {
        await arcEventsApi.publish(flowEvent, data);
      }
    });
  };

  // Forward ALL Flow events to Arc for cross-module subscribers
  for (const eventName of Object.values(FlowEvents)) {
    forward(eventName);
  }
}
