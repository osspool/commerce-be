import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  transport: isDev ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      // IMPORTANT: Pretty output hides these keys from the console.
      // By default we ignore pid/hostname for readability. In Fastify logs, the `req` and `res`
      // objects can carry a lot of data (including headers) and are excluded here. If you want
      // to see request/response objects (and potentially the body if you customize serializers),
      // remove them from the ignore list in the fastify logger below (createFastifyLogger).
      ignore: 'pid,hostname',
      // Always show full error objects
      errorLikeObjectKeys: ['err', 'error'],
      errorProps: 'message,stack,name,code,cause',
    }
  } : undefined,
  // Serialize errors properly
  serializers: {
    error: pino.stdSerializers.err,
    err: pino.stdSerializers.err,
  },
});

export const createFastifyLogger = () => ({
  logger: {
    level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
    // Serialize errors properly
    serializers: {
      // Keep dev logs clean: only method, url, id and statusCode.
      // Do not include headers/cookies/body to avoid noise/PII.
      error: pino.stdSerializers.err,
      err: pino.stdSerializers.err,
      req(request) {
        return {
          id: request.id,
          method: request.method,
          url: request.url,
        };
      },
      res(reply) {
        return {
          statusCode: reply.statusCode,
        };
      },
    },
    ...(isDev && {
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          // Show Fastify request/response details in dev (method, url, statusCode, responseTime)
          // If this becomes too noisy or leaks sensitive info, add keys back to `ignore`.
          ignore: 'pid,hostname',
          // Always show full error objects
          errorLikeObjectKeys: ['err', 'error'],
          errorProps: 'message,stack,name,code,cause',
        }
      }
    })
  },
  // disableRequestLogging: true, // disabling all logs to console for performance
  // customLogLevel: (req, res, err) => {
  //   if (res.statusCode >= 400) return 'warn';  // Log errors
  //   if (res.responseTime > 1000) return 'warn'; // Log slow requests (>1s)
  //   return 'silent'; // Don't log normal requests
  // }
});

// HOW TO LOG REQUEST BODIES (DEV ONLY):
// -------------------------------------
// 1) Remove `req,res` from the `ignore` list above (Fastify pretty transport) so they are printed.
// 2) Provide a custom `req` serializer that includes `body` explicitly (std serializer omits it).
// 3) Consider using `redact` to mask sensitive fields.
//
// Example (commented out on purpose; enable only if you understand the implications):
//
// export const createFastifyLogger = () => ({
//   logger: {
//     level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
//     redact: {
//       paths: ['req.headers.authorization', 'req.body.password', 'req.body.token'],
//       censor: '[REDACTED]'
//     },
//     serializers: {
//       req(request) {
//         const r = pino.stdSerializers.req(request);
//         // Attach parsed body if available (Fastify parses body before preHandler)
//         // Beware: this can be large and may contain PII
//         return { ...r, body: request.body };
//       },
//       res: pino.stdSerializers.res,
//       err: pino.stdSerializers.err,
//       error: pino.stdSerializers.err,
//     },
//     transport: isDev ? {
//       target: 'pino-pretty',
//       options: {
//         colorize: true,
//         translateTime: 'HH:MM:ss',
//         // do NOT ignore `req`/`res` if you want to see them
//         ignore: 'pid,hostname',
//       }
//     } : undefined,
//   }
// });

export default logger;
