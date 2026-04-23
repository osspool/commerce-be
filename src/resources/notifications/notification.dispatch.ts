/**
 * Notification Dispatch Service
 *
 * Orchestrates in-app notification creation, SSE delivery, and email dispatch.
 * Channel activation is controlled by NOTIFICATION_CHANNELS env config.
 */

import { isChannelEnabled } from '#config/sections/notifications.config.js';
import type { SSEManager } from '#core/plugins/sse-manager.plugin.js';
import logger from '#lib/utils/logger.js';
import { notify } from '#shared/notifications/index.js';
import { resolveRecipients } from './notification.recipients.js';
import notificationRepository from './notification.repository.js';
import { buildInAppNotification } from './notification.templates.js';

interface DispatchOptions {
  organizationId: string;
  type: string;
  variables: Record<string, string>;
  /** Override recipients instead of resolving from matrix */
  recipients?: Array<{ userId: string; email?: string; name?: string }>;
  /** User ID that triggered the event (excluded from recipients) */
  triggeredBy?: string;
  priority?: 'low' | 'normal' | 'high';
}

let _sseManager: SSEManager | null = null;

/** Set the SSE manager reference (called during plugin registration). */
export function setSseManager(manager: SSEManager): void {
  _sseManager = manager;
}

/**
 * Dispatch a notification to all resolved recipients.
 *
 * 1. Resolve recipients from the role matrix (or use provided list)
 * 2. Build in-app payload from templates
 * 3. Bulk-create notification records
 * 4. Push via SSE to connected clients
 * 5. Send email if email channel is enabled
 */
export async function dispatchNotification(options: DispatchOptions): Promise<void> {
  const { organizationId, type, variables, triggeredBy, priority = 'normal' } = options;

  try {
    // 1. Resolve recipients
    const recipients = options.recipients || (await resolveRecipients(type, organizationId, triggeredBy));

    if (recipients.length === 0) return;

    // 2. Build in-app payload
    const payload = buildInAppNotification(type, variables);
    if (!payload) {
      logger.warn({ type }, 'No notification template found for type');
      return;
    }

    // 3. Bulk-create in-app notification records
    const docs = recipients.map((r) => ({
      organizationId,
      userId: r.userId,
      type,
      title: payload.title,
      message: payload.message,
      data: payload.data,
      priority,
      read: false,
      readAt: null,
    }));

    await notificationRepository.bulkCreate(docs);

    // 4. Push via SSE to connected clients
    if (_sseManager) {
      for (const r of recipients) {
        _sseManager.push(r.userId, organizationId, 'notification', {
          type,
          title: payload.title,
          message: payload.message,
          data: payload.data,
          priority,
        });
      }
    }

    // 5. Email dispatch (if channel enabled)
    if (isChannelEnabled('email')) {
      for (const r of recipients) {
        if (!r.email) continue;
        // Fire-and-forget — don't block on email delivery
        notify(type, r.email, {
          ...variables,
          recipientName: r.name || '',
        }).catch((err) => {
          logger.warn({ type, email: r.email, error: (err as Error).message }, 'Email dispatch failed');
        });
      }
    }

    logger.debug({ type, organizationId, recipientCount: recipients.length }, 'Notifications dispatched');
  } catch (error) {
    logger.error({ type, organizationId, error: (error as Error).message }, 'Notification dispatch failed');
  }
}
