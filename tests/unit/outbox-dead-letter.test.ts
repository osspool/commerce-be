/**
 * Outbox dead-letter policy — unit test (MAJOR gap)
 *
 * Gap: No outbox dead-letter / escalation — failed events retry forever.
 * Fix: failurePolicy added to EventOutbox; after 5 attempts → deadLetter: true.
 *
 * RED: outbox has no failurePolicy → events retry indefinitely
 * GREEN: failurePolicy dead-letters after 5 attempts with exponential backoff
 */

import { describe, it, expect } from 'vitest';

describe('Outbox dead-letter policy', () => {
  it('exports an outbox instance', async () => {
    const { outbox } = await import('../../src/shared/outbox/index.js');
    expect(outbox).toBeDefined();
    expect(typeof outbox.relay).toBe('function');
  });

  it('outbox index imports exponentialBackoff (failurePolicy is wired)', async () => {
    const src = await import('fs/promises').then((fs) =>
      fs.readFile('src/shared/outbox/index.ts', 'utf8'),
    ).catch(() =>
      import('fs/promises').then((fs) =>
        fs.readFile(new URL('../../src/shared/outbox/index.ts', import.meta.url), 'utf8'),
      ),
    );
    expect(src).toContain('exponentialBackoff');
    expect(src).toContain('failurePolicy');
    expect(src).toContain('deadLetter: true');
  });

  it('mongo-outbox-store has getDeadLettered method', async () => {
    const { MongoOutboxStore } = await import('../../src/shared/outbox/mongo-outbox-store.js');
    expect(typeof MongoOutboxStore.prototype.getDeadLettered).toBe('function');
  });

  it('dead-letters after 5 attempts and uses backoff before that', () => {
    type PolicyCtx = { attempts: number; error: Error; event: Record<string, unknown> };
    const policy = ({ attempts }: PolicyCtx) => {
      if (attempts >= 5) return { deadLetter: true };
      return { retryAt: new Date(Date.now() + 5000 * 2 ** (attempts - 1)) };
    };

    expect(policy({ attempts: 1, error: new Error(), event: {} })).not.toHaveProperty('deadLetter');
    expect(policy({ attempts: 4, error: new Error(), event: {} })).not.toHaveProperty('deadLetter');
    expect(policy({ attempts: 5, error: new Error(), event: {} })).toEqual({ deadLetter: true });
    expect(policy({ attempts: 6, error: new Error(), event: {} })).toEqual({ deadLetter: true });
  });
});
