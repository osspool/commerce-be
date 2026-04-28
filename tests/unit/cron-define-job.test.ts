import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startCronJob } from '../../src/cron/define-job.js';

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof startCronJob>[1];

function setMongoState(state: number): void {
  Object.defineProperty(mongoose.connection, 'readyState', {
    value: state,
    configurable: true,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  setMongoState(1);
  vi.mocked(log.warn).mockClear();
  vi.mocked(log.error).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startCronJob', () => {
  it('runs the job on each interval tick when mongo is connected', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const runner = startCronJob({ name: 'test.job', intervalMs: 1000, run }, log);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(run).toHaveBeenCalledTimes(3);
    runner.stop();
  });

  it('skips the tick silently when mongo is disconnected', async () => {
    setMongoState(0);
    const run = vi.fn().mockResolvedValue(undefined);
    const runner = startCronJob({ name: 'test.job', intervalMs: 1000, run }, log);

    await vi.advanceTimersByTimeAsync(3000);

    expect(run).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    runner.stop();
  });

  it('skips and warns when the previous tick is still running (re-entrancy guard)', async () => {
    let resolveFirst: (() => void) | null = null;
    const run = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );

    const runner = startCronJob({ name: 'test.slow', intervalMs: 1000, run }, log);

    // First tick fires and stays pending.
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);

    // Second interval fires while first is still pending — must skip + warn.
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      { job: 'test.slow' },
      expect.stringContaining('previous still running'),
    );

    // Resolve the first tick — next interval can run again.
    resolveFirst?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);

    runner.stop();
  });

  it('logs an error with the job name when run() throws', async () => {
    const boom = new Error('kaboom');
    const run = vi.fn().mockRejectedValue(boom);
    const runner = startCronJob({ name: 'test.failing', intervalMs: 1000, run }, log);

    await vi.advanceTimersByTimeAsync(1000);

    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: boom, job: 'test.failing' }),
      expect.stringContaining('tick failed'),
    );
    runner.stop();
  });

  it('continues firing on subsequent ticks even after run() throws', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockResolvedValue(undefined);
    const runner = startCronJob({ name: 'test.recover', intervalMs: 1000, run }, log);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(run).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledTimes(1);
    runner.stop();
  });

  it('stop() prevents further ticks', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const runner = startCronJob({ name: 'test.stop', intervalMs: 1000, run }, log);

    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);

    runner.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stop() is idempotent', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const runner = startCronJob({ name: 'test.stop2', intervalMs: 1000, run }, log);

    runner.stop();
    runner.stop();
    runner.stop();

    await vi.advanceTimersByTimeAsync(5000);
    expect(run).not.toHaveBeenCalled();
  });

  it('jitter delays the first tick into [0, jitterMs); stop() before that cancels cleanly', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const runner = startCronJob(
      { name: 'test.jitter', intervalMs: 1000, jitterMs: 5000, run },
      log,
    );

    runner.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run).not.toHaveBeenCalled();
  });

  it('exposes the job name on the runner', () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const runner = startCronJob({ name: 'test.named', intervalMs: 1000, run }, log);
    expect(runner.name).toBe('test.named');
    runner.stop();
  });
});
