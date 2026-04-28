/**
 * Posting handler factory — uniform scaffolding for every accounting
 * event subscriber that lands a journal entry.
 *
 * Built on three Arc primitives that landed in the events module:
 *   - {@link wrapWithSchema} — validates `event.payload` against the
 *     `EventDefinitionOutput<T>`'s registered schema before calling
 *     the inner handler. The handler receives `DomainEvent<T>` with
 *     no cast at the call site.
 *   - {@link withRetry} — retry budget + DLQ for the financial
 *     correctness profile (3 attempts, 2s backoff with jitter,
 *     `onDead` log on exhaustion).
 *   - `EventRegistry` — host-internal accounting events are registered
 *     in [`#shared/event-registry`](../../../shared/event-registry.ts)
 *     so publish-time validation kicks in too (defense in depth).
 *
 * The Zod schema on each handler drives BOTH the registered JSON
 * Schema (via `z.toJSONSchema` in `event-definitions.ts`) AND the
 * runtime `validate` callback below — single source of truth for
 * payload shape.
 *
 * @see ./event-definitions.ts — `EventDefinitionOutput<T>` per event
 * @see ../../../shared/event-registry.ts — registry wiring
 * @see ./handlers/ — one file per posting handler
 */

import {
  type DomainEvent,
  type EventDefinitionOutput,
  type EventLogger,
  type ValidationResult,
  withRetry,
  wrapWithSchema,
} from '@classytic/arc/events';
import type { z } from 'zod';
import { subscribe } from '#lib/events/arcEvents.js';
import type logger from '#lib/utils/logger.js';
import type { PostingInput } from '../posting/posting.service.js';
import { createPosting, ensureCompanyAccounts } from '../posting/posting.service.js';

type Logger = typeof logger;

/**
 * What a handler returns from `build()`. The factory writes this and
 * emits the success log. Returning `null` is an intentional skip — the
 * handler has already logged whatever warning is appropriate (no branch,
 * zero amount, irrelevant gateway, etc.).
 */
export interface PostingWork {
  readonly branchId: string;
  readonly posting: PostingInput;
  readonly logFields?: Record<string, unknown>;
  readonly successMessage?: string;
}

/**
 * Declarative shape of one posting handler.
 *
 *   - `event` — typed `EventDefinitionOutput<T>` (NOT a string). Carries
 *     the topic name AND the registered schema. `T` flows automatically
 *     into `build`'s `payload` parameter — no cast at the call site.
 *   - `payloadSchema` — Zod schema, the source of truth for payload
 *     shape. Drives the registered JSON Schema AND the runtime
 *     `validate` callback wired into `wrapWithSchema`.
 *   - `build` — pure async function that does the domain work and
 *     returns either a `PostingWork` or `null`.
 */
export interface PostingHandler<T> {
  readonly event: EventDefinitionOutput<T>;
  readonly payloadSchema: z.ZodType<T>;
  build(payload: T, log: Logger): Promise<PostingWork | null>;
}

/** Identity helper for type inference. Mirrors `defineEvent` / `defineCronJob`. */
export function definePostingHandler<T>(handler: PostingHandler<T>): PostingHandler<T> {
  return handler;
}

export interface RegisterOptions {
  /** Per-event retry budget. Defaults to 3 attempts with 2s linear backoff. */
  readonly maxRetries?: number;
  readonly backoffMs?: number;
  /** Run `ensureCompanyAccounts()` before each successful build. */
  readonly autoSeedAccounts?: boolean;
}

/**
 * Wire a declarative handler onto the event bus.
 *
 * Composition order (outermost → innermost):
 *   1. `subscribe(event.name, ...)` — the transport hookup
 *   2. `wrapWithSchema(event, ...)` — Zod-driven payload validation;
 *      invalid payloads log + skip without burning retry attempts
 *   3. `withRetry<T>(...)` — retry on handler exceptions, payload type
 *      preserved end-to-end (no cast at the boundary thanks to Arc's
 *      generic signature)
 *   4. The inner async function — `build` + `createPosting` + log
 */
export function registerPostingHandler<T>(handler: PostingHandler<T>, options: RegisterOptions, log: Logger): void {
  const maxRetries = options.maxRetries ?? 3;
  const backoffMs = options.backoffMs ?? 2000;
  const eventName = handler.event.name;

  const inner = async (event: DomainEvent<T>): Promise<void> => {
    const work = await handler.build(event.payload, log);
    if (work === null) return;

    if (options.autoSeedAccounts) {
      await ensureCompanyAccounts();
    }

    const result = await createPosting(work.branchId, work.posting);

    log.info(
      {
        event: eventName,
        branchId: work.branchId,
        journalEntryId: result.journalEntryId,
        ...work.logFields,
      },
      work.successMessage ?? 'posting: journal entry created',
    );
  };

  // `withRetry<T>` is generic — passes `T` straight through, so
  // `wrapWithSchema<T>` accepts it with no cast.
  const retryWrapped = withRetry(inner, {
    maxRetries,
    backoffMs,
    name: eventName,
    onDead: (deadEvent) => {
      log.error({ event: deadEvent, handler: eventName }, 'posting: handler exhausted retries');
    },
  });

  void subscribe(
    eventName,
    wrapWithSchema(handler.event, retryWrapped, {
      // Plug Zod into Arc's CustomValidator slot. The registered JSON
      // schema gives Arc top-level validation; this Zod callback covers
      // nested shapes, enums, and refinements that Arc's built-in
      // minimal validator can't.
      validate: (_schema, payload): ValidationResult => {
        const parsed = handler.payloadSchema.safeParse(payload);
        return parsed.success ? { valid: true } : { valid: false, errors: parsed.error.issues.map((i) => i.message) };
      },
      onInvalid: (_event, errors) => {
        log.warn({ event: eventName, errors }, 'posting: payload validation failed — skipping');
      },
      // Pino's `(obj, msg)` shape is structurally compatible with Arc's
      // `EventLogger` `(msg, ...args)` for the calls Arc actually makes
      // — pino treats the message string as the message and ignores the
      // (no-op) trailing arg.
      logger: log as unknown as EventLogger,
    }),
  );
}
