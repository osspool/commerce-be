// src/utils/email.js
import nodemailer from "nodemailer";
import config from "#config/index.js";

/**
 * Create a nodemailer transporter based on config.email
 */
export function createMailTransporter() {
  const { service, user, pass, from, host, port, secure } = config.email;

  if (service === "gmail") {
    if (!user || !pass) throw new Error("Missing EMAIL_USER/EMAIL_PASS for Gmail");
    return nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass },
    });
  }

  if (service === "titan") {
    if (!user || !pass) throw new Error("Missing EMAIL_USER/EMAIL_PASS for Titan");
    const titanHost = host || "smtp.titan.email";
    const titanPort = port || 587;
    const titanSecure = secure || titanPort === 465;
    return nodemailer.createTransport({
      host: titanHost,
      port: titanPort,
      secure: titanSecure,
      auth: { user, pass },
      ...(titanPort === 587 ? { requireTLS: true } : {}),
      authMethod: "LOGIN",
    });
  }

  if (service === "test" || service === "local" || service === "json") {
    return nodemailer.createTransport({ jsonTransport: true });
  }

  // Custom SMTP fallback
  if (host) {
    const smtpSecure = secure || port === 465;
    return nodemailer.createTransport({
      host,
      port,
      secure: smtpSecure,
      auth: user && pass ? { user, pass } : undefined,
    });
  }

  throw new Error(`Set EMAIL_SERVICE (gmail/titan/test) or EMAIL_HOST for custom SMTP`);
}

// Lazy-init transporter
let _transporter = null;
function getTransporter() {
  if (!_transporter) {
    _transporter = createMailTransporter();
  }
  return _transporter;
}

/**
 * Send an email
 */
export async function sendEmail({ to, subject, text, html, from }) {
  const transporter = getTransporter();

  await transporter.sendMail({
    from: from || config.email.from,
    to,
    subject,
    text,
    html,
  });
}
