/**
 * Email notifications for auth events (password reset, invitations)
 *
 * Uses nodemailer with existing EMAIL_* env vars.
 * Falls back to console logging if SMTP not configured.
 */

import nodemailer from 'nodemailer';

let _transporter = null;

function getTransporter() {
  if (!_transporter) {
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASS;
    const service = process.env.EMAIL_SERVICE || 'gmail';

    if (!user || !pass) {
      console.warn('[email] EMAIL_USER/EMAIL_PASS not set — emails will be logged to console');
      return null;
    }

    _transporter = nodemailer.createTransport({
      service,
      auth: { user, pass },
    });
  }
  return _transporter;
}

/**
 * Send password reset email
 */
export async function sendResetPasswordEmail(user, url) {
  const transporter = getTransporter();
  const fromEmail = process.env.EMAIL_FROM || process.env.EMAIL_USER;

  if (!transporter) {
    console.log(`[email] Password reset for ${user.email}: ${url}`);
    return;
  }

  await transporter.sendMail({
    from: `BigBoss <${fromEmail}>`,
    to: user.email,
    subject: 'Reset your password — BigBoss',
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>Password Reset</h2>
        <p>Hi ${user.name || 'there'},</p>
        <p>You requested a password reset. Click the button below to set a new password:</p>
        <p style="text-align: center; margin: 32px 0;">
          <a href="${url}" style="background: #16a34a; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block;">
            Reset Password
          </a>
        </p>
        <p style="color: #666; font-size: 14px;">If you didn't request this, you can safely ignore this email.</p>
        <p style="color: #666; font-size: 14px;">This link expires in 1 hour.</p>
      </div>
    `,
  });

  console.log(`[email] Password reset sent to ${user.email}`);
}

/**
 * Send organization/branch invitation email
 */
export async function sendInvitationEmail(data) {
  const transporter = getTransporter();
  const fromEmail = process.env.EMAIL_FROM || process.env.EMAIL_USER;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const inviteLink = `${frontendUrl}/accept-invitation/${data.id}`;

  if (!transporter) {
    console.log(`[email] Invitation for ${data.email} to ${data.organization.name}: ${inviteLink}`);
    return;
  }

  await transporter.sendMail({
    from: `BigBoss <${fromEmail}>`,
    to: data.email,
    subject: `You've been invited to ${data.organization.name} — BigBoss`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>Branch Invitation</h2>
        <p>${data.inviter.user.name} invited you to join <strong>${data.organization.name}</strong> as <strong>${data.role}</strong>.</p>
        <p style="text-align: center; margin: 32px 0;">
          <a href="${inviteLink}" style="background: #16a34a; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block;">
            Accept Invitation
          </a>
        </p>
      </div>
    `,
  });

  console.log(`[email] Invitation sent to ${data.email} for branch ${data.organization.name}`);
}
