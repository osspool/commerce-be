/**
 * Worker Module
 *
 * Production-grade worker process utilities for background job processing.
 *
 * Usage:
 *   import { WorkerBootstrap, WorkerHealthServer, setupSignalHandlers } from '#core/worker/index.js';
 *
 *   const worker = new WorkerBootstrap({ concurrency: 2 });
 *   await worker.initialize();
 */

export { WorkerBootstrap } from './WorkerBootstrap.js';
export { WorkerHealthServer } from './WorkerHealthServer.js';
export { setupSignalHandlers } from './signals.js';
