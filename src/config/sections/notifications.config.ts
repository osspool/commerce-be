/**
 * Notifications Configuration
 *
 * Controls which notification delivery channels are active.
 * In-app notifications (bell + SSE) are always enabled.
 *
 * NOTIFICATION_CHANNELS: comma-separated list of active channels
 *   - in_app:  Bell icon + SSE real-time (always on)
 *   - email:   Email alerts via @classytic/notifications
 *   - sms:     SMS alerts (future)
 *   - push:    Mobile push notifications (future)
 *
 * NOTIFICATION_TTL_DAYS: Auto-expire notifications after N days (default: 180)
 */

const KNOWN_CHANNELS = ['in_app', 'email', 'sms', 'push'] as const;
export type NotificationChannel = (typeof KNOWN_CHANNELS)[number];

function parseChannels(raw: string | undefined): Set<string> {
  const channels = new Set<string>();
  channels.add('in_app'); // Always enabled

  if (!raw) return channels;

  for (const entry of raw.split(',')) {
    const ch = entry.trim().toLowerCase();
    if (KNOWN_CHANNELS.includes(ch as NotificationChannel)) {
      channels.add(ch);
    }
  }

  return channels;
}

export interface NotificationConfigSection {
  notifications: {
    /** Active delivery channels (in_app is always included) */
    channels: Set<string>;
    /** TTL in days for auto-expiring old notifications */
    ttlDays: number;
  };
}

const notifications: NotificationConfigSection['notifications'] = {
  channels: parseChannels(process.env.NOTIFICATION_CHANNELS),
  ttlDays: parseInt(process.env.NOTIFICATION_TTL_DAYS || '180', 10),
};

const notificationsConfig: NotificationConfigSection = { notifications };

/** Check if a specific delivery channel is enabled. */
export function isChannelEnabled(channel: string): boolean {
  return notifications.channels.has(channel);
}

export default notificationsConfig;
