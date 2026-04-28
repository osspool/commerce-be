/**
 * Application Factory
 *
 * Thin Arc composition root.
 *
 * Arc owns the boot lifecycle; app-specific wiring lives in `src/core/app/*`.
 */
import './config/env-loader.js';
import type { ResourceLike } from '@classytic/arc/factory';
import { createApp } from '@classytic/arc/factory';
import type { FastifyInstance } from 'fastify';
import { connectDatabase } from './config/db.connect.js';
import { validateEnvironmentOrThrow } from './config/validator.js';

interface CreateApplicationOptions {
  /**
   * Pre-loaded resources. Tests use this to bypass runtime auto-discovery and
   * keep boot deterministic under Vitest.
   */
  resources?: ResourceLike[];
}

async function createApplication(opts: CreateApplicationOptions = {}): Promise<FastifyInstance> {
  // Fail fast on missing/invalid env before contacting the DB or booting Arc.
  // Prevents half-booted apps where the first request reveals a config bug.
  validateEnvironmentOrThrow();
  await connectDatabase();

  // Engines that own Mongoose models register at MODULE-EVAL time (top-level
  // `createXEngine(...)` calls in `accounting.engine.ts`, `pos.engine.ts`).
  // mongokit's `softDeletePlugin` calls `Model.createIndex()` eagerly when it
  // attaches to a schema — if the connection isn't open yet those ops buffer
  // and time out at 10s with `Operation X.createIndex() buffering timed out`.
  //
  // Importing engines here (post-connect) keeps the top-level singleton
  // pattern intact while guaranteeing `mongoose.connection.readyState === 1`
  // by the time any plugin runs createIndex.
  //
  // Dynamic `await import` over a static top-level import: the static
  // import would be hoisted by the bundler / runtime, defeating the
  // ordering. Dynamic import preserves runtime sequencing.
  await import('#resources/accounting/accounting.engine.js');

  // Keep Arc option assembly behind the same post-connect boundary. The
  // options module imports domain bootstrap/plugin modules, and some of
  // those modules register engine-owned Mongoose models at module-eval time.
  // Static-importing it from app.ts reintroduces pre-connect model/index work.
  const { createArcAppOptions } = await import('#core/app/create-arc-app-options.js');

  return createApp(createArcAppOptions({ resources: opts.resources }));
}

export { createApplication };
