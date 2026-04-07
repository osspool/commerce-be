/**
 * Revenue Notification Configuration
 *
 * Currently disabled - admin uses dashboard.
 * Ready for future notifications (app push, SMS, etc.)
 *
 * Uses @classytic/notifications library
 */

/**
 * Create revenue notification hook handlers
 *
 * Currently a stub — no channels are active.
 * Wire up NotificationService when channels are enabled.
 */
export function createRevenueNotificationHandlers(): Record<string, Array<(data: unknown) => Promise<void>>> {
  // No handlers configured yet — return empty map
  return {};
}

/**
 * Dispatch a notification event manually
 *
 * Currently a no-op — no channels are active.
 */
export async function dispatchNotification(_event: string, _data: unknown): Promise<void> {
  // No handlers configured — nothing to dispatch
}
