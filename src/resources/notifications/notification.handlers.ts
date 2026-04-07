/**
 * Notification Event Handlers
 *
 * Generic handler loop — reads from notification.triggers.ts
 * and auto-subscribes to every configured Arc event.
 *
 * Adding a new notification = adding one entry to NOTIFICATION_TRIGGERS.
 * No handler code to write.
 */

import { subscribe } from '#lib/events/arcEvents.js';
import { dispatchNotification } from './notification.dispatch.js';
import { NOTIFICATION_TRIGGERS } from './notification.triggers.js';
import logger from '#lib/utils/logger.js';

interface DomainEvent<T = unknown> {
  payload?: T;
}

let handlersRegistered = false;

export function registerNotificationEventHandlers(options: { force?: boolean } = {}): void {
  const { force = false } = options;
  if (handlersRegistered && !force) return;
  handlersRegistered = true;

  for (const trigger of NOTIFICATION_TRIGGERS) {
    void subscribe(trigger.event, async (event: DomainEvent) => {
      try {
        const payload = (event.payload || {}) as Record<string, any>;
        const extracted = trigger.extract(payload);

        // Skip if extract returns null or missing organizationId
        if (!extracted?.organizationId) return;

        await dispatchNotification({
          organizationId: extracted.organizationId,
          type: trigger.type || trigger.event,
          variables: extracted.variables,
          triggeredBy: extracted.triggeredBy,
          priority: trigger.priority,
        });
      } catch (error) {
        logger.error(
          { event: trigger.event, error: (error as Error).message },
          'Notification trigger failed',
        );
      }
    });
  }

  logger.info(
    { triggers: NOTIFICATION_TRIGGERS.length },
    'Notification event handlers registered',
  );
}
