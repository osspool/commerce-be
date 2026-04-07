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
    subject: '${platformName} — You\'ve been invited to ${orgName}',
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
};
