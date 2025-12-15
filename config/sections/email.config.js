// src/config/sections/email.config.js
export default {
  email: {
    service: (process.env.EMAIL_SERVICE || "").toLowerCase() || null,
    user: process.env.EMAIL_USER || null,
    pass: process.env.EMAIL_PASS || null,
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER || null,
    host: process.env.EMAIL_HOST || null,
    port: process.env.EMAIL_PORT ? Number(process.env.EMAIL_PORT) : 587,
    secure: process.env.EMAIL_SECURE === "true",
  },
};
