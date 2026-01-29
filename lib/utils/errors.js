export const errorHandler = (err, request, reply) => {
  const isDev = process.env.NODE_ENV !== 'production';

  if (isDev) {
    request.log.error({ err, url: request.url }, 'Request error');
  }

  const statusCode = err.statusCode || err.status || 500;
  const response = {
    success: false,
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: err.message || 'Internal server error',
      ...(err.details && { details: err.details }),
      ...(isDev && err.stack && { stack: err.stack }),
    }
  };

  reply.code(statusCode).send(response);
};

export default errorHandler;
