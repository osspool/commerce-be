/**
 * Custom Error Classes
 *
 * Extends Arc errors with app-specific error types.
 * These are caught by the global error handler.
 */

interface ErrorWithStatus extends Error {
  statusCode: number;
  code?: string;
}

/**
 * Create an error with statusCode
 */
export function createError(statusCode: number, message: string, code?: string): ErrorWithStatus {
  const error = new Error(message) as ErrorWithStatus;
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

/**
 * Not found error (404)
 */
export class NotFoundError extends Error {
  readonly statusCode = 404;

  constructor(message: string = 'Resource not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

/**
 * Bad request error (400)
 */
export class BadRequestError extends Error {
  readonly statusCode = 400;

  constructor(message: string = 'Bad request') {
    super(message);
    this.name = 'BadRequestError';
  }
}

/**
 * Unauthorized error (401)
 */
export class UnauthorizedError extends Error {
  readonly statusCode = 401;

  constructor(message: string = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * Forbidden error (403)
 */
export class ForbiddenError extends Error {
  readonly statusCode = 403;

  constructor(message: string = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/**
 * Conflict error (409)
 */
export class ConflictError extends Error {
  readonly statusCode = 409;

  constructor(message: string = 'Conflict') {
    super(message);
    this.name = 'ConflictError';
  }
}

export default {
  createError,
  NotFoundError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
};
