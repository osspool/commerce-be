import mongoose from 'mongoose';
import createError from 'http-errors';

export class ErrorHandler {
  static handle(error, context = {}) {
    if (error instanceof mongoose.Error.ValidationError) {
      const messages = Object.values(error.errors).map(err => err.message);
      return createError(400, `Validation Error: ${messages.join(', ')}`, {
        violations: error.errors,
        context,
      });
    }

    if (error instanceof mongoose.Error.CastError) {
      return createError(400, `Invalid ${error.path}: ${error.value}`, {
        field: error.path,
        value: error.value,
        context,
      });
    }

    if (error instanceof mongoose.Error.DocumentNotFoundError) {
      return createError(404, 'Document not found', { context });
    }

    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern || {})[0];
      return createError(409, `Duplicate value for field: ${field}`, {
        field,
        context,
      });
    }

    if (error.status && error.message) {
      return error;
    }

    return createError(500, error.message || 'Internal Server Error', { context });
  }

  static async wrapAsync(fn, context = {}) {
    try {
      return await fn();
    } catch (error) {
      throw ErrorHandler.handle(error, context);
    }
  }

  static middleware(logger) {
    return async (error, req, reply) => {
      const handled = ErrorHandler.handle(error, {
        path: req.url,
        method: req.method,
        user: req.user?.id,
      });

      logger?.error?.(handled.message, {
        status: handled.status,
        stack: handled.stack,
        context: handled.context,
      });

      return reply.code(handled.status || 500).send({
        success: false,
        error: {
          message: handled.message,
          status: handled.status,
          ...(process.env.NODE_ENV === 'development' && { stack: handled.stack }),
        },
      });
    };
  }
}

export default ErrorHandler;
