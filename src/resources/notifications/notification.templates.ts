/**
 * In-App Notification Template Engine
 *
 * Reads template definitions from notification.triggers.ts (single source of truth).
 * Provides interpolation and payload building.
 */

import { NOTIFICATION_TRIGGERS } from './notification.triggers.js';

export interface InAppPayload {
  title: string;
  message: string;
  data?: {
    link?: string;
    entityId?: string;
    entityType?: string;
  };
}

function interpolate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => variables[key] ?? `{${key}}`);
}

/**
 * Build an in-app notification payload from a type and variables.
 * Looks up the template from the trigger registry.
 */
export function buildInAppNotification(type: string, variables: Record<string, string>): InAppPayload | null {
  const trigger = NOTIFICATION_TRIGGERS.find((t) => (t.type || t.event) === type);
  if (!trigger) return null;

  const { template } = trigger;
  const entityId = variables.orderId || variables.transferId || variables.productId;

  return {
    title: interpolate(template.title, variables),
    message: interpolate(template.message, variables),
    data: {
      link: template.link ? interpolate(template.link, variables) : undefined,
      entityId,
      entityType: template.entityType,
    },
  };
}

/** Get all registered notification types (for admin UI / docs). */
export function getNotificationTypes(): string[] {
  return NOTIFICATION_TRIGGERS.map((t) => t.type || t.event);
}
