/**
 * Streamline Plugin — Global workflow engine registration.
 *
 * Registered ONCE in app.ts bootstrap. Creates ONE shared Streamline container
 * backed by Arc's shared `MemoryEventTransport` so that every workflow
 * lifecycle + step event is published to the same event bus that all other
 * Arc domain events flow through (canonical `streamline:*` names), collects
 * workflows from all domain modules, registers Arc's `streamlinePlugin`
 * (REST + lifecycle bridge + SSE + step-event bridge), and ensures the
 * `WorkflowRunModel` has a TTL index so finished runs are auto-deleted after
 * `STREAMLINE_TTL_DAYS`.
 *
 * Domain modules export workflow factories that take a shared container;
 * this plugin creates the container once and passes it to every factory so
 * all workflows share a single bus (required for step-event bridging and
 * SSE streaming on Arc's `streamlinePlugin`).
 *
 * New workflows are added here — one import line per module.
 */

import { streamlinePlugin } from '@classytic/arc/integrations/streamline';
import {
  createContainer,
  type StreamlineContainer,
  WorkflowRunModel,
} from '@classytic/streamline';
import type { FastifyPluginAsync } from 'fastify';
import config from '#config/index.js';
import { eventTransport } from '#lib/events/EventBus.js';
import logger from '#lib/utils/logger.js';

const DAY_MS = 86_400;

async function ensureTtlIndex(ttlDays: number): Promise<void> {
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) return;
  const expireAfterSeconds = Math.floor(ttlDays * DAY_MS);
  // Partial filter: only purge terminal runs. Active runs must never be deleted.
  await WorkflowRunModel.collection.createIndex(
    { updatedAt: 1 },
    {
      name: 'streamline_ttl_terminal_runs',
      expireAfterSeconds,
      partialFilterExpression: {
        status: { $in: ['done', 'failed', 'cancelled'] },
      },
    },
  );
}

const plugin: FastifyPluginAsync = async (fastify) => {
  if (!config.streamline.enabled) {
    logger.info('Streamline workflow engine disabled (STREAMLINE_ENABLED=false)');
    return;
  }

  // ── Shared container (Arc event transport + global event bus) ────────────
  // Wiring every workflow through ONE container means:
  //   1. Workflow events are published on Arc's `MemoryEventTransport` under
  //      canonical `streamline:<resource>.<verb>` names — any
  //      `fastify.events.subscribe('streamline:*', ...)` handler sees them.
  //   2. `bridgeStepEvents` + `enableStreaming` in arc's `streamlinePlugin`
  //      work (they need `wf.container.eventBus` which is now shared).
  //   3. Telemetry subscribers get workflow events alongside domain events.
  const container: StreamlineContainer = createContainer({
    eventBus: 'global',
    eventTransport,
  });

  // ── Collect workflows from domain modules ────────────────────────────────
  // Each module exports a factory `(container) => Workflow[]`. Factories let
  // the plugin inject the shared container so every workflow shares the bus.

  // biome-ignore lint/suspicious/noExplicitAny: workflow types are loose across packages
  const workflows: any[] = [];

  if (config.invoice.engine) {
    const { createInvoiceWorkflows } = await import(
      '#resources/accounting/invoice/invoice.workflows.js'
    );
    workflows.push(...createInvoiceWorkflows(container));
  }

  // Subscription billing sweep — replaces the prior `subscription.billing.due`
  // cron. Self-rescheduling workflow that survives restarts and runs exactly
  // once per cycle across replicas (streamline scheduler claim is race-safe).
  const { createSubscriptionWorkflows, SUBSCRIPTION_BILLING_SWEEP_KEY } = await import(
    '#resources/payments/subscription/subscription.workflows.js'
  );
  const subscriptionWorkflows = createSubscriptionWorkflows(container);
  workflows.push(...subscriptionWorkflows);

  // Future modules:
  // if (config.loyalty.enabled) {
  //   const { createLoyaltyWorkflows } = await import('#resources/sales/loyalty/loyalty.workflows.js');
  //   workflows.push(...createLoyaltyWorkflows(container));
  // }

  if (workflows.length === 0) {
    logger.info('Streamline: no workflows registered');
    return;
  }

  // ── Register Arc's streamlinePlugin ──────────────────────────────────────
  // Creates REST endpoints: POST /start, GET /runs/:id, POST /resume, etc.
  // Bridges workflow lifecycle events → Arc event bus via `fastify.events`.

  // NOTE: Do NOT pass `prefix` to `fastify.register()`. Fastify treats it
  // as a reserved routing option and would stack it on top of the plugin's
  // internal prefix, yielding `/workflows/workflows/<id>/start` instead of
  // `/workflows/<id>/start`. Arc's `streamlinePlugin` defaults its internal
  // prefix to `/workflows`, which is what we want (the surrounding
  // `register-domain-bootstrap` scope already applies the `/api/v1`
  // prefix, so the final path is `/api/v1/workflows/<id>/start`).
  // Arc 2.13 renamed `bridgeStepEvents` → `bridgeBusEvents` to better
  // describe what the flag does (subscribe to the workflow's internal
  // event bus, which carries step + lifecycle + engine telemetry events).
  // Same default-off behavior; we opt in for dashboards / monitoring.
  await fastify.register(streamlinePlugin, {
    workflows,
    auth: true,
    bridgeEvents: true,
    bridgeBusEvents: true,
    enableStreaming: config.isDevelopment,
  });

  // ── Auto-start singleton recurring workflows ─────────────────────────────
  // Self-rescheduling workflows (subscription billing sweep, etc.) need an
  // initial `start()` call so the scheduler picks them up. Idempotency keys
  // dedupe across pods + restarts: streamline's `findActiveByIdempotencyKey`
  // returns the existing active run instead of creating a parallel one.
  // Fire-and-forget — if the start fails (transient Mongo blip), the next
  // boot retries; we don't gate boot on a workflow start.
  const billingSweepWorkflow = subscriptionWorkflows[0];
  if (billingSweepWorkflow) {
    billingSweepWorkflow
      .start({}, { idempotencyKey: SUBSCRIPTION_BILLING_SWEEP_KEY })
      .then((run: { _id: string; status: string }) => {
        fastify.log.info(
          { runId: run._id, status: run.status, workflow: 'subscription-billing-sweep' },
          'Streamline: singleton recurring workflow ensured',
        );
      })
      .catch((err: unknown) => {
        fastify.log.warn(
          { err, workflow: 'subscription-billing-sweep' },
          'Streamline: failed to ensure singleton recurring workflow (will retry next boot)',
        );
      });
  }

  // ── TTL index for terminal runs ──────────────────────────────────────────
  // Mongo's TTL monitor will auto-delete `done | failed | cancelled` runs
  // older than `streamline.ttlDays`. Safe to call repeatedly; `createIndex`
  // is idempotent for identical specs.
  //
  // Fire-and-log — DO NOT await. Atlas index creation can take 10-30s on
  // a fresh collection; awaiting here exceeds Fastify's default plugin
  // timeout and crashes boot with `AVV_ERR_PLUGIN_EXEC_TIMEOUT`. The
  // index is opportunistic (Mongo's TTL monitor only purges what's
  // there); a few seconds of "no auto-purge" while it builds is
  // strictly preferable to refusing to serve traffic at all.
  ensureTtlIndex(config.streamline.ttlDays).catch((err) => {
    fastify.log.warn(
      { err, ttlDays: config.streamline.ttlDays },
      'Streamline: failed to ensure TTL index (background)',
    );
  });

  // Arc's `streamlinePlugin` already registers its own `onClose` that calls
  // `wf.shutdown()` for every workflow in its registry — do NOT duplicate it
  // here. A second shutdown races against the first and can emit
  // "listener already removed" warnings from the shared event bus.

  logger.info(
    {
      workflows: workflows.map((w: { definition?: { id?: string } }) => w.definition?.id ?? 'unknown'),
      sharedContainer: true,
      bridgeStepEvents: true,
      ttlDays: config.streamline.ttlDays,
    },
    'Streamline workflow engine initialized',
  );
};

export default plugin;
