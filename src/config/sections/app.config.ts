// src/config/sections/app.config.ts
import { parseBoolean, parseDelimitedString, parseIntEnv } from '../utils.js';

export interface BetterAuthConfig {
  secret: string | undefined;
  url: string | undefined;
}

export interface AppSectionConfig {
  adminEmail: string | undefined;
  port: number;
  url: string;
  frontendUrl: string;
  deviceWebhookSecret: string | undefined;
  disableCronJobs: boolean | undefined;
  trackProductViews: boolean;
}

export interface RateLimitConfig {
  windowMs: number;
  max: number;
}

export interface CorsConfig {
  origin: boolean | string[];
  credentials: boolean;
  methods: string[];
  allowedHeaders: string[];
  exposedHeaders: string[];
}

export interface AppConfigSection {
  betterAuth: BetterAuthConfig;
  app: AppSectionConfig;
  rateLimit: RateLimitConfig;
  cors: CorsConfig;
}

const corsOriginsFromEnv: string[] = parseDelimitedString(process.env.CORS_ORIGIN);
const env: string = process.env.NODE_ENV || process.env.ENV || 'dev';
const isDevelopment: boolean = env === 'dev' || env === 'development';

const appConfig: AppConfigSection = {
  betterAuth: {
    secret: process.env.BETTER_AUTH_SECRET,
    url: process.env.BETTER_AUTH_URL,
  },
  app: {
    adminEmail: process.env.EMAIL_USER,
    port: parseIntEnv(process.env.PORT, 8050),
    url: process.env.APP_URL || `http://localhost:${process.env.PORT || 8050}`,
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
    deviceWebhookSecret: process.env.DEVICE_WEBHOOK_SECRET,
    disableCronJobs: parseBoolean(process.env.DISABLE_CRON_JOBS),
    // Feature flags (keep simple: 0 = disabled, 1 = enabled)
    trackProductViews: parseIntEnv(process.env.TRACK_PRODUCT_VIEWS, 0) === 1,
  },

  rateLimit: {
    windowMs: parseIntEnv(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000), // 15 minutes
    max: parseIntEnv(process.env.RATE_LIMIT_MAX, 100), // limit each IP to 100 requests per windowMs
  },

  cors: {
    // In dev: allow all origins. In prod: use env var or specific origins
    origin: isDevelopment
      ? true // Allow all origins in development
      : corsOriginsFromEnv.length > 0
        ? corsOriginsFromEnv
        : ['http://localhost:3000'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    exposedHeaders: ['Content-Range', 'X-Content-Range'],
  },
};

export default appConfig;
