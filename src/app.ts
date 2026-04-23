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
import { createArcAppOptions } from '#core/app/create-arc-app-options.js';
import { connectDatabase } from './config/db.connect.js';
import { validateEnvironmentOrThrow } from './config/validator.js';

// Engines that own models — must init BEFORE Arc resource discovery runs so
// resource files can reference engine-owned models at definition time.
// Engine import — eager top-level singleton, models registered as a side effect
import '#resources/accounting/accounting.engine.js';

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
  return createApp(createArcAppOptions({ resources: opts.resources }));
}

export { createApplication };
