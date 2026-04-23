/**
 * Email Notification Channel
 * Extends @classytic/notifications base class
 */

import { arcLog } from '@classytic/arc/logger';
import type { ChannelConfig, NotificationPayload, SendResult } from '@classytic/notifications';
import { BaseChannel } from '@classytic/notifications';
import { renderTemplate } from './templates/index.js';

const log = arcLog('email-channel');

interface EmailChannelConfig extends ChannelConfig {
  [key: string]: unknown;
}

/**
 * Inline sendEmail utility
 * Logs in development, can be swapped for nodemailer in production
 */
async function sendEmail(opts: { to: string; subject: string; html: string; text: string }): Promise<void> {
  // In production, replace with actual email transport (nodemailer, SES, etc.)
  log.info(`Sending email to ${opts.to}: ${opts.subject}`);
}

export class EmailChannel extends BaseChannel {
  declare config: EmailChannelConfig;

  constructor(config: EmailChannelConfig = {}) {
    super({ name: 'email', ...config });
  }

  async send(notification: NotificationPayload): Promise<SendResult> {
    const { event, recipient, data } = notification;
    if (!recipient?.email) {
      return { status: 'skipped' as const, channel: 'email' };
    }

    try {
      const { subject, html, text } = renderTemplate(event, data as Record<string, unknown>);

      await sendEmail({
        to: recipient.email,
        subject,
        html,
        text,
      });

      log.info(`Sent ${event} to ${recipient.email}`);
      return { status: 'sent' as const, channel: 'email' };
    } catch (error) {
      const err = error as Error;
      log.error(`Failed to send ${event}:`, err.message);
      throw error;
    }
  }

  shouldHandle(event: string): boolean {
    const events = this.config.events;
    if (!events || events.length === 0) return true;
    return events.includes(event);
  }
}
