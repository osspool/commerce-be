/**
 * Email Notification Channel
 * Extends @classytic/notifications base class
 */

import { NotificationChannel } from '@classytic/notifications';
import { sendEmail } from '#utils/email.js';
import { renderTemplate } from './templates/index.js';

export class EmailChannel extends NotificationChannel {
  constructor(config = {}) {
    super(config);
  }

  async send({ event, recipient, data }) {
    if (!recipient?.email) {
      return { status: 'skipped', reason: 'no_email' };
    }

    try {
      const { subject, html, text } = renderTemplate(event, data);
      
      await sendEmail({
        to: recipient.email,
        subject,
        html,
        text,
      });

      console.log(`[EmailChannel] Sent ${event} to ${recipient.email}`);
      return { status: 'sent', email: recipient.email };
    } catch (error) {
      console.error(`[EmailChannel] Failed to send ${event}:`, error.message);
      throw error;
    }
  }

  getSupportedEvents() {
    return this.config.events || [];
  }
}
