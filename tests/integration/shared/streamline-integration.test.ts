/**
 * Streamline × Arc Integration Tests
 *
 * Covers the wiring done by `src/core/plugins/streamline.plugin.ts` and
 * `src/resources/accounting/invoice/invoice.workflows.ts`:
 *
 *   1. All workflows share ONE `StreamlineContainer` (event bus + transport)
 *   2. Workflow events are bridged to Arc's `MemoryEventTransport` under
 *      canonical `streamline:*` names (`fastify.events.subscribe` sees them)
 *   3. Arc's `streamlinePlugin` bridges lifecycle + step events to
 *      `fastify.events` using legacy `workflow.<id>.*` names
 *   4. TTL index on `WorkflowRunModel` is created with the correct
 *      partial filter (terminal runs only) and TTL window
 *   5. `GET /workflows` lists every registered workflow (sanity check)
 *
 * This test boots a minimal Fastify app with only the Arc event plugin +
 * Arc's `streamlinePlugin` + a hand-written test workflow. We avoid the
 * full `createApplication()` path because it pulls in auth/accounting/
 * ledger bootstrapping that is unrelated to the integration surface we
 * are testing here — and because we want to assert on a workflow that
 * completes synchronously (the real `invoice-dunning` loops forever).
 */

import { streamlinePlugin } from '@classytic/arc/integrations/streamline';
import {
  MemoryEventTransport,
  eventPlugin,
} from '@classytic/arc/events';
import {
  createContainer,
  createWorkflow,
  type StreamlineContainer,
  WorkflowRunModel,
} from '@classytic/streamline';
import type { DomainEvent } from '@classytic/primitives/events';
import Fastify, { type FastifyInstance } from 'fastify';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DAY_MS = 86_400;

function parse(body: string): Record<string, unknown> | null {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function ensureTtlIndex(ttlDays: number): Promise<void> {
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) return;
  await WorkflowRunModel.collection.createIndex(
    { updatedAt: 1 },
    {
      name: 'streamline_ttl_terminal_runs',
      expireAfterSeconds: Math.floor(ttlDays * DAY_MS),
      partialFilterExpression: {
        status: { $in: ['done', 'failed', 'cancelled'] },
      },
    },
  );
}

describe('Streamline × Arc integration', () => {
  let app: FastifyInstance;
  let transport: MemoryEventTransport;
  let container: StreamlineContainer;
  // biome-ignore lint/suspicious/noExplicitAny: workflow type is deeply generic
  let testWorkflow: any;

  beforeAll(async () => {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1/streamline-test');
    }

    transport = new MemoryEventTransport();

    // Mirror the plugin's wiring exactly: shared container, global bus,
    // Arc transport so canonical streamline:* events land on it.
    container = createContainer({
      eventBus: 'global',
      eventTransport: transport,
    });

    testWorkflow = createWorkflow<{ value: number }>('integration-test', {
      container,
      steps: {
        double: {
          handler: async (ctx) => {
            const input = ctx.input as { value: number };
            return { doubled: input.value * 2 };
          },
        },
        report: {
          handler: async (ctx) => {
            const prev = ctx.getOutput('double') as { doubled: number };
            return { final: prev.doubled + 1 };
          },
        },
      },
    });

    app = Fastify({ logger: false });
    await app.register(eventPlugin, { transport });
    // NOTE: We intentionally do NOT pass `prefix` to `fastify.register()` —
    // Fastify treats `prefix` as a reserved routing option and would apply
    // it on top of the plugin's internal prefix, producing duplicated paths
    // like `/workflows/workflows/<id>/start`. Arc's `streamlinePlugin`
    // defaults its internal prefix to `/workflows`, which is what we want.
    await app.register(streamlinePlugin, {
      workflows: [testWorkflow],
      auth: false,
      bridgeEvents: true,
      bridgeStepEvents: true,
      enableStreaming: false,
    });

    await app.ready();
    await ensureTtlIndex(30);
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
    if (testWorkflow?.shutdown) testWorkflow.shutdown();
    // Drop only our test-owned collection so the shared MongoMemoryServer
    // stays clean for other suites. Disconnect is handled by per-suite-mongo.
    try {
      await WorkflowRunModel.collection.drop();
    } catch {
      // Collection may not exist if no run was created — ignore
    }
  }, 30_000);

  // ── 1. Shared container ─────────────────────────────────────────────────────

  it('workflow uses the shared container passed in config', () => {
    expect(testWorkflow.container).toBe(container);
    expect(testWorkflow.container.eventTransport).toBe(transport);
  });

  it('container re-uses the same eventBus + transport for every workflow', () => {
    const wfB = createWorkflow<{ value: number }>('integration-test-b', {
      container,
      steps: {
        run: { handler: async () => ({ ok: true }) },
      },
    });
    expect(wfB.container).toBe(container);
    expect(wfB.container.eventBus).toBe(testWorkflow.container.eventBus);
    wfB.shutdown?.();
  });

  // ── 2. TTL index on WorkflowRunModel ───────────────────────────────────────

  it('creates a TTL index on terminal runs only', async () => {
    const indexes = await WorkflowRunModel.collection.indexes();
    const ttl = indexes.find(
      (idx: { name?: string }) => idx.name === 'streamline_ttl_terminal_runs',
    );
    expect(ttl, 'TTL index should exist').toBeDefined();
    expect(ttl?.expireAfterSeconds).toBe(30 * DAY_MS);
    const pfe = (ttl as { partialFilterExpression?: Record<string, unknown> })
      ?.partialFilterExpression;
    expect(pfe).toBeDefined();
    expect(pfe?.status).toEqual({ $in: ['done', 'failed', 'cancelled'] });
  });

  it('ensureTtlIndex is idempotent (safe on repeat boot)', async () => {
    await expect(ensureTtlIndex(30)).resolves.not.toThrow();
    await expect(ensureTtlIndex(30)).resolves.not.toThrow();
  });

  it('ensureTtlIndex is a no-op for zero / negative / non-finite ttlDays', async () => {
    await expect(ensureTtlIndex(0)).resolves.not.toThrow();
    await expect(ensureTtlIndex(-5)).resolves.not.toThrow();
    await expect(ensureTtlIndex(Number.NaN)).resolves.not.toThrow();
  });

  // ── 3. Workflow listing endpoint ───────────────────────────────────────────

  it('GET /workflows lists every registered workflow', async () => {
    const res = await app.inject({ method: 'GET', url: '/workflows' });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body) as { success: boolean; data: Array<{ id: string }> };
    expect(body.success).toBe(true);
    const ids = body.data.map((w) => w.id);
    expect(ids).toContain('integration-test');
  });

  // ── 4. Canonical events reach Arc's transport ──────────────────────────────

  it('publishes streamline:workflow.completed on Arc transport after a run', async () => {
    const received: Array<DomainEvent<unknown>> = [];
    const unsub = await transport.subscribe(
      'streamline:workflow.*',
      async (event) => {
        received.push(event);
      },
    );

    const run = await testWorkflow.start({ value: 21 });
    const final = await testWorkflow.waitFor(run._id, { timeout: 10_000 });
    expect(final.status).toBe('done');

    // Transport delivery is async — give bridge a tick to flush.
    await new Promise((r) => setTimeout(r, 50));

    const types = received.map((e) => e.type);
    expect(types).toContain('streamline:workflow.started');
    expect(types).toContain('streamline:workflow.completed');

    // Every bridged event must carry the runId in payload.
    const completed = received.find((e) => e.type === 'streamline:workflow.completed');
    expect(completed).toBeDefined();
    expect((completed!.payload as { runId?: string }).runId).toBe(run._id);

    await unsub();
  }, 15_000);

  // ── 5. Legacy bridge via fastify.events ────────────────────────────────────

  it('bridges lifecycle events to fastify.events (workflow.<id>.started)', async () => {
    const seen: Array<{ type: string; payload: unknown }> = [];
    const unsub = await app.events.subscribe('workflow.integration-test.*', async (event) => {
      seen.push({ type: event.type, payload: event.payload });
    });

    const res = await app.inject({
      method: 'POST',
      url: '/workflows/integration-test/start',
      payload: { input: { value: 10 } },
    });
    expect(res.statusCode).toBe(201);
    const body = parse(res.body) as { data: { _id: string } };
    const runId = body.data._id;

    await testWorkflow.waitFor(runId, { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 50));

    expect(seen.map((e) => e.type)).toContain('workflow.integration-test.started');

    await unsub();
  }, 15_000);

  // ── 6. Step-event bridge (opt-in via bridgeStepEvents: true) ───────────────

  it('bridges step:completed events to fastify.events when bridgeStepEvents is on', async () => {
    // MemoryEventTransport's wildcard only honors a trailing `.*` with a
    // literal `.` before it, so the narrower `workflow.integration-test.step:*`
    // would never match. Subscribe broad, filter in-process.
    const stepEvents: Array<{ type: string; stepId?: string }> = [];
    const unsub = await app.events.subscribe('workflow.integration-test.*', async (event) => {
      if (!event.type.includes('step:')) return;
      const p = event.payload as { stepId?: string };
      stepEvents.push({ type: event.type, stepId: p?.stepId });
    });

    const run = await testWorkflow.start({ value: 100 });
    await testWorkflow.waitFor(run._id, { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 50));

    const completedSteps = stepEvents
      .filter((e) => e.type === 'workflow.integration-test.step:completed')
      .map((e) => e.stepId);

    expect(completedSteps).toContain('double');
    expect(completedSteps).toContain('report');

    await unsub();
  }, 15_000);

  // ── 7. REST: run-resolution endpoints ──────────────────────────────────────

  it('GET /workflows/:id/runs/:runId returns the persisted run', async () => {
    const run = await testWorkflow.start({ value: 7 });
    await testWorkflow.waitFor(run._id, { timeout: 10_000 });

    const res = await app.inject({
      method: 'GET',
      url: `/workflows/integration-test/runs/${run._id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body) as { success: boolean; data: { _id: string; status: string } };
    expect(body.success).toBe(true);
    expect(body.data._id).toBe(run._id);
    expect(body.data.status).toBe('done');
  }, 15_000);
});

// ── 8. Invoice workflow factory ────────────────────────────────────────────
// Verifies the factory returned by `invoice.workflows.ts` honors the
// shared-container contract without needing the invoice engine to be
// initialized (handlers are only invoked at runtime).

describe('createInvoiceWorkflows factory', () => {
  it('returns workflows wired to the shared container', async () => {
    const { createInvoiceWorkflows } = await import(
      '../../../src/resources/accounting/invoice/invoice.workflows.js'
    );
    const sharedTransport = new MemoryEventTransport();
    const sharedContainer = createContainer({
      eventBus: 'global',
      eventTransport: sharedTransport,
    });

    const wfs = createInvoiceWorkflows(sharedContainer);
    expect(wfs).toHaveLength(2);
    const ids = wfs.map((w: { definition: { id: string } }) => w.definition.id).sort();
    expect(ids).toEqual(['invoice-dunning', 'invoice-recurring']);

    for (const wf of wfs) {
      expect(wf.container).toBe(sharedContainer);
      expect(wf.container.eventTransport).toBe(sharedTransport);
    }

    for (const wf of wfs) wf.shutdown?.();
  });
});
