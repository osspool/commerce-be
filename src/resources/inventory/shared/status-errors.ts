/**
 * Shared StatusError utility for inventory services.
 *
 * Provides a typed HTTP error class and factory function used by
 * transfer, purchase, and other inventory domain services.
 */

export interface StatusError extends Error {
  statusCode: number;
}

export function createStatusError(message: string, statusCode: number = 400): StatusError {
  const error = new Error(message) as StatusError;
  error.statusCode = statusCode;
  return error;
}
