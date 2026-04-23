import pino from 'pino';

const isDev: boolean = process.env.NODE_ENV !== 'production';

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
  serializers: {
    error: pino.stdSerializers.err,
    err: pino.stdSerializers.err,
  },
});

export default logger;
