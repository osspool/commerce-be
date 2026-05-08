import pino from 'pino';

// NOTE: this module is loaded VERY early (before src/config/index.ts is
// importable in some boot paths), so it deliberately reads `process.env`
// directly instead of going through the config aggregator.
const isDev: boolean = process.env.NODE_ENV !== 'production';

/**
 * Sensitive-field redaction. pino replaces matched paths with `[Redacted]`
 * before transport. Patterns are static — no env reading, no allocations
 * per log call. Order matters only for performance (specific paths first).
 *
 * Covers:
 *  - Auth: bearer tokens on every request, password fields in any
 *    user/credential payload, cookies (Better Auth tokens, session ids).
 *  - Secrets: anything we care about that gets stringified into a log
 *    line via `error.cause` or a copied `req.body` (BETTER_AUTH_SECRET,
 *    DB URI, payment-provider keys).
 *
 * Keep this list aligned with `src/config/sections/app.config.ts` —
 * every secret env var should have a corresponding redact path so that
 * if a config snapshot ever lands in a log, it's neutralized.
 */
const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-better-auth-token"]',
  'request.headers.authorization',
  'request.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordConfirm',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.idToken',
  '*.bearerToken',
  '*.apiKey',
  '*.secret',
  '*.clientSecret',
  '*.privateKey',
  '*.MONGO_URI',
  '*.BETTER_AUTH_SECRET',
  '*.DEVICE_WEBHOOK_SECRET',
  'body.password',
  'body.token',
  'body.secret',
];

export const logger: pino.Logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
          errorLikeObjectKeys: ['err', 'error'],
          errorProps: 'message,stack,name,code,cause',
        },
      }
    : undefined,
  redact: {
    paths: [...REDACT_PATHS],
    censor: '[Redacted]',
    remove: false,
  },
  serializers: {
    error: pino.stdSerializers.err,
    err: pino.stdSerializers.err,
  },
});

export default logger;
