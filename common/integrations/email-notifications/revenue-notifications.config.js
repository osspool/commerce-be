/**
 * Revenue Notification Configuration
 * 
 * Currently disabled - admin uses dashboard.
 * Ready for future notifications (app push, SMS, etc.)
 * 
 * Uses @classytic/notifications library
 */

import { createNotificationHandlers } from '@classytic/notifications';
import { EmailChannel } from './email.channel.js';

/**
 * Notification channels (none active currently)
 */
const channels = [
  new EmailChannel({
    enabled: false, // Disabled - admin uses dashboard
    events: [],
  }),
];

/**
 * Notification configurations (empty - add later as needed)
 */
const notificationConfigs = [
  // Future notifications:
  // - App push notifications for order updates
  // - SMS for delivery status
  // - etc.
];

/**
 * Create revenue notification hook handlers
 */
export function createRevenueNotificationHandlers() {
  return createNotificationHandlers(notificationConfigs, channels);
}

/**
 * Dispatch a notification event manually
 */
export async function dispatchNotification(event, data) {
  const handlers = createNotificationHandlers(notificationConfigs, channels);
  const eventHandlers = handlers[event];

  if (!eventHandlers || eventHandlers.length === 0) {
    return; // No handlers configured
  }

  for (const handler of eventHandlers) {
    try {
      await handler(data);
    } catch (error) {
      console.error(`[Notifications] Handler failed for ${event}:`, error.message);
    }
  }
}
