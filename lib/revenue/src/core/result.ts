/**
 * Result Type - Rust-inspired error handling
 * @classytic/revenue
 *
 * No more try/catch - explicit, type-safe error handling
 * Inspired by: Rust Result<T, E>, neverthrow, Effect-TS
 */

/**
 * Success result
 */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
  readonly error?: never;
}

/**
 * Error result
 */
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
  readonly value?: never;
}

/**
 * Result type - either Ok<T> or Err<E>
 */
export type Result<T, E = Error> = Ok<T> | Err<E>;

/**
 * Create a success result
 */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/**
 * Create an error result
 */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/**
 * Check if result is Ok
 */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok === true;
}

/**
 * Check if result is Err
 */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return result.ok === false;
}

/**
 * Unwrap a result, throwing if it's an error
 * Use sparingly - prefer pattern matching
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw result.error;
}

/**
 * Unwrap a result with a default value
 */
export function unwrapOr<T, E>(result: Result<T, E>, defaultValue: T): T {
  return result.ok ? result.value : defaultValue;
}

/**
 * Map over a successful result
 */
export function map<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U
): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/**
 * Map over an error result
 */
export function mapErr<T, E, F>(
  result: Result<T, E>,
  fn: (error: E) => F
): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

/**
 * Flat map (chain) results
 */
export function flatMap<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>
): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}

/**
 * Try-catch wrapper that returns Result
 */
export async function tryCatch<T, E = Error>(
  fn: () => Promise<T>,
  mapError?: (e: unknown) => E
): Promise<Result<T, E>> {
  try {
    const value = await fn();
    return ok(value);
  } catch (e) {
    const error = mapError ? mapError(e) : (e as E);
    return err(error);
  }
}

/**
 * Synchronous try-catch wrapper
 */
export function tryCatchSync<T, E = Error>(
  fn: () => T,
  mapError?: (e: unknown) => E
): Result<T, E> {
  try {
    const value = fn();
    return ok(value);
  } catch (e) {
    const error = mapError ? mapError(e) : (e as E);
    return err(error);
  }
}

/**
 * Combine multiple results - all must succeed
 */
export function all<T extends readonly Result<unknown, unknown>[]>(
  results: T
): Result<
  { [K in keyof T]: T[K] extends Result<infer U, unknown> ? U : never },
  T[number] extends Result<unknown, infer E> ? E : never
> {
  const values: unknown[] = [];
  for (const result of results) {
    if (!result.ok) return result as any;
    values.push(result.value);
  }
  return ok(values as any);
}

/**
 * Pattern match on result
 */
export function match<T, E, U>(
  result: Result<T, E>,
  handlers: {
    ok: (value: T) => U;
    err: (error: E) => U;
  }
): U {
  return result.ok ? handlers.ok(result.value) : handlers.err(result.error);
}

export const Result = {
  ok,
  err,
  isOk,
  isErr,
  unwrap,
  unwrapOr,
  map,
  mapErr,
  flatMap,
  tryCatch,
  tryCatchSync,
  all,
  match,
} as const;

export default Result;

