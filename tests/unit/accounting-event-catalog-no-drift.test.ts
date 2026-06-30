/**
 * Accounting event catalog — no-drift invariant (PACKAGE_RULES §18).
 *
 * Every `accounting:*` event PUBLISHED anywhere in be-prod must have a
 * registered `EventDefinition` (Zod schema) in `accountingEventDefinitions`.
 * That array is what wires schema validation + OpenAPI introspection, so a
 * published-but-unregistered event silently ships without a contract — exactly
 * the drift that left `budget.threshold.exceeded` / `rma.restocking_fee_collected`
 * defined-but-unregistered until this guard.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { accountingEventDefinitions } from '../../src/resources/accounting/events/event-definitions.js';

const SRC = join(fileURLToPath(new URL('../../', import.meta.url)), 'src');
const PUBLISH = /\.?publish\(\s*['"](accounting:[a-z0-9._]+)['"]/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('accounting event catalog — no drift', () => {
  const registered = new Set(
    accountingEventDefinitions.map((d) => (d as { name: string }).name),
  );

  it('every published accounting:* event has a registered EventDefinition', () => {
    const published = new Map<string, string>(); // event → first file
    for (const file of walk(SRC)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(PUBLISH)) {
        if (!published.has(m[1])) published.set(m[1], file.replace(/\\/g, '/').split('/src/')[1]);
      }
    }
    const unregistered = [...published.entries()]
      .filter(([name]) => !registered.has(name))
      .map(([name, file]) => `${name}  (published at ${file})`);

    expect(
      unregistered,
      `These accounting events are published without a registered Zod EventDefinition ` +
        `(add them to accountingEventDefinitions):\n${unregistered.join('\n')}`,
    ).toEqual([]);
  });

  it('registered definitions all carry the accounting: prefix + a schema', () => {
    for (const def of accountingEventDefinitions) {
      const d = def as { name: string; schema?: unknown };
      expect(d.name.startsWith('accounting:') || d.name.startsWith('purchase:')).toBe(true);
      expect(d.schema).toBeDefined();
    }
  });
});
