// src/config/sections/app.config.js
import { parseInt, parseDelimitedString, parseBoolean } from '../utils.js'; // Assume utils file created below

const corsOriginsFromEnv = parseDelimitedString(process.env.CORS_ORIGIN);
const env = process.env.NODE_ENV || process.env.ENV || "dev";
const isDevelopment = env === "dev" || env === "development";

export default {
  app: {
    adminEmail: process.env.EMAIL_USER,
    port: parseInt(process.env.PORT, 8040),
    url:
      process.env.APP_URL || `http://localhost:${process.env.PORT || 8040}`,
    frontendUrl: process.env.FRONTEND_URL || "http://localhost:3000",
    jwtSecret: process.env.JWT_SECRET,
    jwtRefresh: process.env.JWT_REFRESH_SECRET,
    sessionSecret: process.env.SESSION_SECRET,
    cookieSecret: process.env.COOKIE_SECRET, // Fallback to JWT_SECRET if not set
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || "3d",
    jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
    deviceWebhookSecret: process.env.DEVICE_WEBHOOK_SECRET,
    disableCronJobs: parseBoolean(process.env.DISABLE_CRON_JOBS),
    // Feature flags (keep simple: 0 = disabled, 1 = enabled)
    trackProductViews: parseInt(process.env.TRACK_PRODUCT_VIEWS, 0) === 1,
  },

  rateLimit: {
    windowMs: parseInt(
      process.env.RATE_LIMIT_WINDOW_MS,
      15 * 60 * 1000
    ), // 15 minutes
    max: parseInt(process.env.RATE_LIMIT_MAX, 100), // limit each IP to 100 requests per windowMs
  },

  cors: {
    // In dev: allow all origins. In prod: use env var or specific origins
    origin: isDevelopment
      ? true  // Allow all origins in development
      : (corsOriginsFromEnv.length > 0
          ? corsOriginsFromEnv
          : ["http://localhost:3000"]),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    exposedHeaders: ['Content-Range', 'X-Content-Range'],
  },
};