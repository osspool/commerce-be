import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const subscribeMock = vi.fn();
const createPostingMock = vi.fn();
const ensureCompanyAccountsMock = vi.fn();

// Identity mocks for Arc's wrappers — return the inner handler so
// the test can drive the inner pipeline directly. Each mock records
// its call args so we can assert composition order + options.
const withRetryMock = vi.fn(
  (handler: (event: unknown) => Promise<void>, _config: Record<string, unknown>) => handler,
);
const wrapWithSchemaMock = vi.fn(
  (
    _definition: unknown,
    handler: (event: unknown) => Promise<void>,
    _options: Record<string, unknown>,
  ) => handler,
);

vi.mock('#lib/events/arcEvents.js', () => ({
  subscribe: (...args: unknown[]) => subscribeMock(...args),
}));

vi.mock('@classytic/arc/events', () => ({
  withRetry: (handler: (event: unknown) => Promise<void>, config: Record<string, unknown>) =>
    withRetryMock(handler, config),
  wrapWithSchema: (
    definition: unknown,
    handler: (event: unknown) => Promise<void>,
    options: Record<string, unknown>,
  ) => wrapWithSchemaMock(definition, handler, options),
}));

vi.mock('../../src/resources/accounting/posting/posting.service.js', () => ({
  createPosting: (...args: unknown[]) => createPostingMock(...args),
  ensureCompanyAccounts: () => ensureCompanyAccountsMock(),
}));

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<
  typeof import('../../src/resources/accounting/events/define-posting-handler.js').registerPostingHandler
>[2];

let registerPostingHandler: typeof import('../../src/resources/accounting/events/define-posting-handler.js').registerPostingHandler;
let definePostingHandler: typeof import('../../src/resources/accounting/events/define-posting-handler.js').definePostingHandler;

beforeEach(async () => {
  vi.resetModules();
  subscribeMock.mockReset();
  createPostingMock.mockReset().mockResolvedValue({ journalEntryId: 'JE-1', state: 'posted' });
  ensureCompanyAccountsMock.mockReset().mockResolvedValue(undefined);
  withRetryMock.mockClear();
  wrapWithSchemaMock.mockClear();
  vi.mocked(log.info).mockClear();
  vi.mocked(log.warn).mockClear();
  vi.mocked(log.error).mockClear();

  const mod = await import('../../src/resources/accounting/events/define-posting-handler.js');
  registerPostingHandler = mod.registerPostingHandler;
  definePostingHandler = mod.definePostingHandler;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const baseSchema = z.object({ id: z.string(), branchId: z.string() });

// A minimal EventDefinitionOutput stand-in. The factory only reads
// `name` and forwards the whole object to wrapWithSchema (which is
// mocked above), so this shape is sufficient for the unit test.
const fakeDefinition = {
  name: 'test:event',
  version: 1,
  schema: { type: 'object' as const },
  create: (payload: unknown) => ({ type: 'test:event', payload, meta: {} }),
};

function makeHandler(
  build: (
    p: z.infer<typeof baseSchema>,
    log: typeof console,
  ) => Promise<{
    branchId: string;
    posting: { items: unknown[]; date: Date };
    logFields?: Record<string, unknown>;
    successMessage?: string;
  } | null>,
) {
  return definePostingHandler({
    event: fakeDefinition as Parameters<typeof definePostingHandler>[0]['event'],
    payloadSchema: baseSchema,
    build: build as Parameters<typeof definePostingHandler>[0]['build'],
  });
}

async function dispatchEvent(payload: unknown): Promise<void> {
  // Identity mocks: subscribe receives the innermost (post-wrap) function.
  const [, handlerFn] = subscribeMock.mock.calls[0] ?? [];
  if (typeof handlerFn !== 'function') throw new Error('subscribe was not called');
  await handlerFn({ payload });
}

describe('registerPostingHandler', () => {
  it('subscribes against the EventDefinition name with a wrapped handler', () => {
    const handler = makeHandler(async (p) => ({
      branchId: p.branchId,
      posting: { items: [], date: new Date() },
    }));

    registerPostingHandler(handler, {}, log);

    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock.mock.calls[0]?.[0]).toBe('test:event');
  });

  it('composes wrapWithSchema(definition, withRetry(inner, retryOpts), schemaOpts)', () => {
    const handler = makeHandler(async (p) => ({
      branchId: p.branchId,
      posting: { items: [], date: new Date() },
    }));

    registerPostingHandler(handler, {}, log);

    expect(withRetryMock).toHaveBeenCalledTimes(1);
    expect(withRetryMock.mock.calls[0]?.[1]).toMatchObject({
      maxRetries: 3,
      backoffMs: 2000,
      name: 'test:event',
    });

    expect(wrapWithSchemaMock).toHaveBeenCalledTimes(1);
    expect(wrapWithSchemaMock.mock.calls[0]?.[0]).toBe(fakeDefinition);
    expect(wrapWithSchemaMock.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        validate: expect.any(Function),
        onInvalid: expect.any(Function),
        logger: expect.any(Object),
      }),
    );
  });

  it('uses custom retry config when supplied', () => {
    const handler = makeHandler(async (p) => ({
      branchId: p.branchId,
      posting: { items: [], date: new Date() },
    }));

    registerPostingHandler(handler, { maxRetries: 5, backoffMs: 500 }, log);

    expect(withRetryMock.mock.calls[0]?.[1]).toMatchObject({
      maxRetries: 5,
      backoffMs: 500,
    });
  });

  it('skips silently when build() returns null (intentional handler skip)', async () => {
    const handler = makeHandler(async () => null);

    registerPostingHandler(handler, {}, log);
    await dispatchEvent({ id: 'x', branchId: 'b1' });

    expect(createPostingMock).not.toHaveBeenCalled();
    expect(ensureCompanyAccountsMock).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('writes via createPosting and emits the success log on success', async () => {
    const date = new Date('2026-04-28T00:00:00Z');
    const handler = makeHandler(async (p) => ({
      branchId: p.branchId,
      posting: { items: [{ a: 1 }], date },
      logFields: { id: p.id },
      successMessage: 'Test posted',
    }));

    registerPostingHandler(handler, {}, log);
    await dispatchEvent({ id: 'X-7', branchId: 'b-42' });

    expect(createPostingMock).toHaveBeenCalledWith('b-42', { items: [{ a: 1 }], date });
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'test:event',
        branchId: 'b-42',
        journalEntryId: 'JE-1',
        id: 'X-7',
      }),
      'Test posted',
    );
  });

  it('runs ensureCompanyAccounts() when autoSeedAccounts is enabled, skips when not', async () => {
    const handler = makeHandler(async (p) => ({
      branchId: p.branchId,
      posting: { items: [], date: new Date() },
    }));

    registerPostingHandler(handler, { autoSeedAccounts: true }, log);
    await dispatchEvent({ id: 'a', branchId: 'b' });
    expect(ensureCompanyAccountsMock).toHaveBeenCalledTimes(1);

    subscribeMock.mockClear();
    ensureCompanyAccountsMock.mockClear();
    registerPostingHandler(handler, { autoSeedAccounts: false }, log);
    await dispatchEvent({ id: 'a', branchId: 'b' });
    expect(ensureCompanyAccountsMock).not.toHaveBeenCalled();
  });

  it('does NOT seed accounts when build() returns null', async () => {
    const handler = makeHandler(async () => null);

    registerPostingHandler(handler, { autoSeedAccounts: true }, log);
    await dispatchEvent({ id: 'a', branchId: 'b' });

    expect(ensureCompanyAccountsMock).not.toHaveBeenCalled();
  });

  it('uses the default success message when handler omits it', async () => {
    const handler = makeHandler(async (p) => ({
      branchId: p.branchId,
      posting: { items: [], date: new Date() },
    }));

    registerPostingHandler(handler, {}, log);
    await dispatchEvent({ id: 'a', branchId: 'b' });

    expect(log.info).toHaveBeenCalledWith(
      expect.any(Object),
      'posting: journal entry created',
    );
  });

  it('forwards a Zod-backed validate callback to wrapWithSchema (valid → pass)', () => {
    const handler = makeHandler(async (p) => ({
      branchId: p.branchId,
      posting: { items: [], date: new Date() },
    }));

    registerPostingHandler(handler, {}, log);

    const opts = wrapWithSchemaMock.mock.calls[0]?.[2] as {
      validate: (s: unknown, p: unknown) => { valid: boolean; errors?: string[] };
    };
    expect(opts.validate({}, { id: 'x', branchId: 'b' })).toEqual({ valid: true });
  });

  it('forwards a Zod-backed validate callback to wrapWithSchema (invalid → error array)', () => {
    const handler = makeHandler(async (p) => ({
      branchId: p.branchId,
      posting: { items: [], date: new Date() },
    }));

    registerPostingHandler(handler, {}, log);

    const opts = wrapWithSchemaMock.mock.calls[0]?.[2] as {
      validate: (s: unknown, p: unknown) => { valid: boolean; errors?: string[] };
    };
    const result = opts.validate({}, { id: 'x' }); // missing branchId
    expect(result.valid).toBe(false);
    expect(result.errors?.length).toBeGreaterThan(0);
  });

  it('forwards an onInvalid callback that logs structured warn', () => {
    const handler = makeHandler(async (p) => ({
      branchId: p.branchId,
      posting: { items: [], date: new Date() },
    }));

    registerPostingHandler(handler, {}, log);

    const opts = wrapWithSchemaMock.mock.calls[0]?.[2] as {
      onInvalid: (e: unknown, errs: string[]) => void;
    };
    opts.onInvalid({ payload: {} }, ['boom']);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'test:event', errors: ['boom'] }),
      expect.stringContaining('payload validation failed'),
    );
  });

  it('threads onDead through withRetry and logs with handler name on exhaustion', () => {
    const handler = makeHandler(async (p) => ({
      branchId: p.branchId,
      posting: { items: [], date: new Date() },
    }));

    registerPostingHandler(handler, {}, log);

    const config = withRetryMock.mock.calls[0]?.[1] as { onDead?: (e: unknown) => void };
    config.onDead?.({ payload: { boom: true } });

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: { payload: { boom: true } },
        handler: 'test:event',
      }),
      'posting: handler exhausted retries',
    );
  });
});
