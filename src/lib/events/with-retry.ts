/**
 * Local withRetry shim — replaces @classytic/arc/events' withRetry, which was
 * removed in arc 2.6.3. Wraps an async event handler with bounded retries +
 * exponential backoff and a dead-letter callback when retries are exhausted.
 */

export interface WithRetryOptions {
  maxRetries?: number;
  backoffMs?: number;
  name?: string;
  onDead?: (event: unknown, error: unknown) => void | Promise<void>;
}

type Handler = (event: unknown) => unknown | Promise<unknown>;

export function withRetry(handler: Handler, opts: WithRetryOptions = {}): Handler {
  const maxRetries = opts.maxRetries ?? 3;
  const backoffMs = opts.backoffMs ?? 1000;

  return async (event: unknown) => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await handler(event);
      } catch (err) {
        lastErr = err;
        if (attempt === maxRetries) break;
        const delay = backoffMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    if (opts.onDead) {
      try {
        await opts.onDead(event, lastErr);
      } catch {
        // swallow — we're already in dead-letter territory
      }
    }
    throw lastErr;
  };
}
