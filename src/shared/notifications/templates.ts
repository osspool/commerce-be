/**
 * Email Templates — Static HTML strings with ${variable} interpolation.
 * Used by @classytic/notifications createSimpleResolver.
 *
 * Context vars are injected by the caller. Platform name comes from env.
 */

const BUTTON_STYLE =
  'background: #16a34a; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block;';

const MUTED_STYLE = 'color: #666; font-size: 14px;';

function wrap(content: string): string {
  return `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">${content}</div>`;
}

export const templates = {
  password_reset: {
    subject: '${platformName} — Reset your password',
    html: wrap(`
      <h2>Password Reset</h2>
      <p>Hi \${name},</p>
      <p>You requested a password reset. Click the button below to set a new password:</p>
      <p style="text-align: center; margin: 32px 0;">
        <a href="\${resetUrl}" style="${BUTTON_STYLE}">Reset Password</a>
      </p>
      <p style="${MUTED_STYLE}">If you didn't request this, you can safely ignore this email.</p>
      <p style="${MUTED_STYLE}">This link expires in 1 hour.</p>
    `),
  },

  invitation: {
    subject: "${platformName} — You've been invited to ${orgName}",
    html: wrap(`
      <h2>Branch Invitation</h2>
      <p>\${inviterName} invited you to join <strong>\${orgName}</strong> as <strong>\${roles}</strong>.</p>
      <p style="text-align: center; margin: 32px 0;">
        <a href="\${inviteUrl}" style="${BUTTON_STYLE}">Accept Invitation</a>
      </p>
      <p style="${MUTED_STYLE}">This invitation expires in 7 days.</p>
    `),
  },

  invitation_accepted: {
    subject: '${platformName} — ${userName} joined ${orgName}',
    html: wrap(`
      <h2>New Member Joined</h2>
      <p><strong>\${userName}</strong> accepted the invitation and joined <strong>\${orgName}</strong> as <strong>\${roles}</strong>.</p>
    `),
  },

  email_verification: {
    subject: '${platformName} — Verify your email',
    html: wrap(`
      <h2>Verify Your Email</h2>
      <p>Hi \${name},</p>
      <p>Thanks for signing up! Please verify your email address to activate your account.</p>
      <p style="text-align: center; margin: 32px 0;">
        <a href="\${verificationUrl}" style="${BUTTON_STYLE}">Verify Email</a>
      </p>
      <p style="${MUTED_STYLE}">If you didn't create an account, you can safely ignore this email.</p>
    `),
  },

  welcome: {
    subject: 'Welcome to ${platformName}!',
    html: wrap(`
      <h2>Welcome!</h2>
      <p>Hi \${name},</p>
      <p>Your account has been created. You can now sign in to manage your store.</p>
      <p style="text-align: center; margin: 32px 0;">
        <a href="\${loginUrl}" style="${BUTTON_STYLE}">Sign In</a>
      </p>
    `),
  },

  // ── Invoice / Accounting ────────────────────────────────────────────────────

  'invoice:sent': {
    subject: '${platformName} — Invoice ${invoiceNumber}',
    html: wrap(`
      <h2>Invoice \${invoiceNumber}</h2>
      <p>Hi \${recipientName},</p>
      <p>Please find your invoice details below.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="${MUTED_STYLE}">Invoice No.</td><td style="text-align:right;font-weight:600;">\${invoiceNumber}</td></tr>
        <tr><td style="${MUTED_STYLE}">Date</td><td style="text-align:right;">\${invoiceDate}</td></tr>
        <tr><td style="${MUTED_STYLE}">Due Date</td><td style="text-align:right;">\${dueDate}</td></tr>
        <tr style="border-top:1px solid #eee;"><td style="${MUTED_STYLE};padding-top:8px;">Amount Due</td><td style="text-align:right;padding-top:8px;font-size:18px;font-weight:700;">\${currency} \${amountDue}</td></tr>
      </table>
      \${message}
      <p style="text-align: center; margin: 32px 0;">
        <a href="\${invoiceUrl}" style="${BUTTON_STYLE}">View Invoice</a>
      </p>
      <p style="${MUTED_STYLE}">Payment is due by \${dueDate}. Please contact us if you have any questions.</p>
    `),
  },

  'invoice:reminder.sent': {
    subject: '${platformName} — Payment Reminder: Invoice ${invoiceNumber}',
    html: wrap(`
      <h2>Payment Reminder</h2>
      <p>Hi \${recipientName},</p>
      <p>This is a friendly reminder that invoice <strong>\${invoiceNumber}</strong> has an outstanding balance.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="${MUTED_STYLE}">Invoice No.</td><td style="text-align:right;font-weight:600;">\${invoiceNumber}</td></tr>
        <tr><td style="${MUTED_STYLE}">Due Date</td><td style="text-align:right;">\${dueDate}</td></tr>
        <tr style="border-top:1px solid #eee;"><td style="${MUTED_STYLE};padding-top:8px;">Outstanding</td><td style="text-align:right;padding-top:8px;font-size:18px;font-weight:700;color:#dc2626;">\${currency} \${amountDue}</td></tr>
      </table>
      <p style="text-align: center; margin: 32px 0;">
        <a href="\${invoiceUrl}" style="${BUTTON_STYLE}">View & Pay Invoice</a>
      </p>
      <p style="${MUTED_STYLE}">If you've already made this payment, please disregard this reminder.</p>
    `),
  },

  'invoice:paid': {
    subject: '${platformName} — Payment Received for Invoice ${invoiceNumber}',
    html: wrap(`
      <h2>Payment Received</h2>
      <p>Hi \${recipientName},</p>
      <p>We've received your payment for invoice <strong>\${invoiceNumber}</strong>.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="${MUTED_STYLE}">Invoice No.</td><td style="text-align:right;font-weight:600;">\${invoiceNumber}</td></tr>
        <tr><td style="${MUTED_STYLE}">Amount Paid</td><td style="text-align:right;font-weight:600;color:#16a34a;">\${currency} \${amountPaid}</td></tr>
        <tr><td style="${MUTED_STYLE}">Remaining</td><td style="text-align:right;">\${currency} \${amountDue}</td></tr>
      </table>
      <p style="text-align: center; margin: 32px 0;">
        <a href="\${invoiceUrl}" style="${BUTTON_STYLE}">View Invoice</a>
      </p>
      <p style="${MUTED_STYLE}">Thank you for your payment!</p>
    `),
  },

  'invoice:quote.sent': {
    subject: '${platformName} — Quote ${invoiceNumber}',
    html: wrap(`
      <h2>Quote \${invoiceNumber}</h2>
      <p>Hi \${recipientName},</p>
      <p>We've prepared a quote for you. Please review the details below.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="${MUTED_STYLE}">Quote No.</td><td style="text-align:right;font-weight:600;">\${invoiceNumber}</td></tr>
        <tr><td style="${MUTED_STYLE}">Date</td><td style="text-align:right;">\${invoiceDate}</td></tr>
        <tr><td style="${MUTED_STYLE}">Valid Until</td><td style="text-align:right;">\${expiryDate}</td></tr>
        <tr style="border-top:1px solid #eee;"><td style="${MUTED_STYLE};padding-top:8px;">Total</td><td style="text-align:right;padding-top:8px;font-size:18px;font-weight:700;">\${currency} \${totalAmount}</td></tr>
      </table>
      <p style="text-align: center; margin: 32px 0;">
        <a href="\${invoiceUrl}" style="${BUTTON_STYLE}">View Quote</a>
      </p>
      <p style="${MUTED_STYLE}">This quote is valid until \${expiryDate}. Contact us if you have any questions.</p>
    `),
  },
};
