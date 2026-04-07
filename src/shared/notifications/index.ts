/**
 * Notification Service — thin wrapper over @classytic/notifications.
 *
 * - Email only (no SMS/push for now)
 * - Static templates with ${variable} interpolation
 * - Falls back to console if SMTP not configured
 * - Reads config from EMAIL_* env vars
 */

import {
  NotificationService,
  EmailChannel,
  ConsoleChannel,
  createSimpleResolver,
} from '@classytic/notifications';
import { templates } from './templates.js';

let _service: NotificationService | null = null;

function getPlatformName(): string {
  return process.env.PLATFORM_NAME || 'BigBoss';
}

function getFrontendUrl(): string {
  return process.env.FRONTEND_URL || 'http://localhost:3000';
}

function getService(): NotificationService {
  if (_service) return _service;

  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  const service = process.env.EMAIL_SERVICE || 'gmail';
  const from = process.env.EMAIL_FROM || user || 'noreply@localhost';

  const hasSmtp = !!user && !!pass;

  const channels = hasSmtp
    ? [
        new EmailChannel({
          from: `${getPlatformName()} <${from}>`,
          transport: { service, auth: { user, pass } },
        }),
      ]
    : [new ConsoleChannel()];

  _service = new NotificationService({
    channels,
    templates: createSimpleResolver(templates),
  });

  if (!hasSmtp) {
    console.warn('[notifications] SMTP not configured — using console channel');
  }

  return _service;
}

/**
 * Send a notification using a named template.
 *
 * @param template - Template name (password_reset, invitation, etc.)
 * @param to - Recipient email address
 * @param data - Template context variables
 */
export async function notify(
  template: string,
  to: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  const service = getService();

  await service.send({
    event: template,
    recipient: { email: to },
    template,
    data: {
      platformName: getPlatformName(),
      frontendUrl: getFrontendUrl(),
      ...data,
    },
  });
}

/** Reset the service singleton (for tests). */
export function resetNotificationService(): void {
  _service = null;
}

export { templates } from './templates.js';
