/**
 * Notification Module Events
 *
 * Events emitted by the notification system itself.
 */

import { defineEvent } from '@classytic/arc/events';
import type { EventDefinition } from '@classytic/arc';
import { eventRegistry } from '#shared/event-registry.js';

// --- Payload Interfaces ---

interface NotificationCreatedPayload {
  organizationId: string;
  type: string;
  recipientCount: number;
}

interface NotificationReadPayload {
  notificationId: string;
  userId: string;
  organizationId: string;
}

interface NotificationBroadcastPayload {
  organizationId: string;
  title: string;
  message: string;
  broadcastBy: string;
}

// --- Event Definitions ---

export const NotificationCreated = defineEvent<NotificationCreatedPayload>({
  name: 'notification:created',
  description: 'Emitted when notifications are dispatched to recipients',
  schema: {
    type: 'object',
    required: ['organizationId', 'type', 'recipientCount'],
    properties: {
      organizationId: { type: 'string' },
      type: { type: 'string' },
      recipientCount: { type: 'number' },
    },
  },
});

export const NotificationRead = defineEvent<NotificationReadPayload>({
  name: 'notification:read',
  description: 'Emitted when a notification is marked as read',
  schema: {
    type: 'object',
    required: ['notificationId', 'userId', 'organizationId'],
    properties: {
      notificationId: { type: 'string' },
      userId: { type: 'string' },
      organizationId: { type: 'string' },
    },
  },
});

export const NotificationBroadcast = defineEvent<NotificationBroadcastPayload>({
  name: 'notification:broadcast',
  description: 'Emitted when an admin broadcasts a system announcement',
  schema: {
    type: 'object',
    required: ['organizationId', 'title', 'message', 'broadcastBy'],
    properties: {
      organizationId: { type: 'string' },
      title: { type: 'string' },
      message: { type: 'string' },
      broadcastBy: { type: 'string' },
    },
  },
});

// --- Registry ---

eventRegistry.register(NotificationCreated);
eventRegistry.register(NotificationRead);
eventRegistry.register(NotificationBroadcast);

// --- For defineResource() compatibility ---

export const events: Record<string, EventDefinition> = {
  'notification:created': NotificationCreated,
  'notification:read': NotificationRead,
  'notification:broadcast': NotificationBroadcast,
};
