/**
 * Cron job factory — wraps a job function with the standard scaffolding
 * every interval-driven background tick needs in this codebase:
 *
 *   - **Mongo-connection guard** — silently no-op while disconnected
 *     (boot, replica failover) instead of throwing.
 *   - **Re-entrancy guard** — if the previous tick is still running when
 *     the next interval fires, log a warning and skip. Prevents two
 *     concurrent sweeps stomping on each other (e.g. when a 5-min
 *     reservation cleanup ever takes >5 min on a busy day).
 *   - **Named structured logging** — every error log carries `{ job }` as
 *     a queryable field, not buried in the message string. Filter logs
 *     by job name in production.
 *   - **Optional jitter** — random initial delay so daily/hourly batch
 *     jobs don't all fire at the same minute mark on every restart.
 *
 * Why this exists: 7+ cron timers in `index.ts` were each repeating the
 * same 8-line scaffold. New jobs would copy-paste it (and forget bits).
 * One factory, one place to evolve operational concerns (metrics, hold-
 * lock, distributed coordination if we ever scale to multi-pod).
 *
 * Why not Bull/BullMQ/Agenda: be-prod runs single-pod and doesn't need
 * persistence or distributed locking for these jobs (TTL-driven cleanup
 * is idempotent; the outbox uses leases at the storage layer). Adding a
 * Redis-backed queue would buy nothing today.
 */

import mongoose from 'mongoose';
import type logger from '#lib/utils/logger.js';
import { getCronInstanceId, tryAcquireCronLock } from './cron-lock.js';

type Logger = typeof logger;

export interface CronJob {
  /** Stable identifier — appears as `{ job }` in structured logs. */
  readonly name: string;
  /** How often to fire. Use the constants in `index.ts`. */
  readonly intervalMs: number;
  /** The work to do. Should be idempotent (cron may retry on next tick). */
  run(): Promise<void>;
  /**
   * Random initial delay in `[0, jitterMs)` before the FIRST tick.
   * Spreads boot-aligned jobs across a window so multiple daily jobs
   * don't all fire at exactly `boot + 24h`. Optional — only matters
   * once we have ≥2 jobs at the same cadence.
   */
  readonly jitterMs?: number;
}

export interface CronRunner {
  readonly name: string;
  /** Idempotent — safe to call multiple times. */
  stop(): void;
}

function isMongoConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

export function startCronJob(job: CronJob, log: Logger): CronRunner {
  let running = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  async function tick(): Promise<void> {
    if (!isMongoConnected()) return;
    if (running) {
      log.warn({ job: job.name }, 'cron: skipped tick — previous still running');
      return;
    }

    // Multi-replica leader lock — only one instance per cluster runs the
    // tick per cycle. Lease is 90% of the interval so a crashed leader
    // is reclaimed within one cycle. The cron-lock module silently
    // returns `false` on Mongo disconnects / write conflicts — those
    // turn into a skipped tick, not an exception.
    const leaseMs = Math.max(1_000, Math.floor(job.intervalMs * 0.9));
    const acquired = await tryAcquireCronLock(job.name, leaseMs);
    if (!acquired) {
      log.debug({ job: job.name, instance: getCronInstanceId() }, 'cron: skipped — another replica holds the lease');
      return;
    }

    running = true;
    const start = Date.now();
    try {
      await job.run();
    } catch (err) {
      log.error({ err, job: job.name, durationMs: Date.now() - start }, 'cron: tick failed');
    } finally {
      running = false;
    }
  }

  const initialDelay = job.jitterMs ? Math.floor(Math.random() * job.jitterMs) : 0;
  const startTimer = setTimeout(() => {
    if (stopped) return;
    interval = setInterval(tick, job.intervalMs);
    interval.unref();
  }, initialDelay);
  startTimer.unref();

  return {
    name: job.name,
    stop: () => {
      stopped = true;
      clearTimeout(startTimer);
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    },
  };
}
