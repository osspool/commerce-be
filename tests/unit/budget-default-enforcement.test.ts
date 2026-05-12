/**
 * Budget default enforcement — REAL behavior test
 *
 * Spawns a child Node process with the BUDGET_DEFAULT_ENFORCEMENT env var
 * set and verifies the accounting config honors the env var. This is the
 * env-var → config wiring (the "real" gap-fix). The downstream
 * config → mongoose schema wiring is validated by the contract test
 * (budget-default-enforcement-contract.test.ts).
 *
 * Subprocess pattern avoids vitest's module-cache fighting against the
 * env-var-at-import-time semantics.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { resolve } from 'path';
import { writeFileSync, unlinkSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const CONFIG_URL = pathToFileURL(resolve(REPO_ROOT, 'src/config/sections/accounting.config.ts')).href;

interface ProbeResult {
  configValue: string;
  thresholdConfig: number;
}

function runWithEnv(env: Record<string, string>, unset: string[] = []): ProbeResult {
  const tmp = mkdtempSync(`${tmpdir()}/bgt-test-`);
  const script = resolve(tmp, 'probe.mjs');
  writeFileSync(
    script,
    `const m = await import('${CONFIG_URL}');\nprocess.stdout.write('___R___' + JSON.stringify({ configValue: m.default.accounting.budget.defaultActionIfExceeded, thresholdConfig: m.default.accounting.budget.defaultThresholdPercent }));`,
  );
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, NODE_ENV: 'test' };
  for (const k of unset) delete childEnv[k];

  try {
    const out = execSync(`npx tsx "${script}"`, {
      cwd: REPO_ROOT,
      env: childEnv,
      timeout: 60_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });
    const idx = out.lastIndexOf('___R___');
    if (idx < 0) throw new Error(`Probe failed — no result marker in output:\n${out}`);
    return JSON.parse(out.slice(idx + 7).trim()) as ProbeResult;
  } finally {
    try { unlinkSync(script); } catch { /* ignore */ }
  }
}

describe('Budget default enforcement — real env-var → config wiring', () => {
  it('BUDGET_DEFAULT_ENFORCEMENT=stop is honored', () => {
    const result = runWithEnv({ BUDGET_DEFAULT_ENFORCEMENT: 'stop' });
    expect(result.configValue).toBe('stop');
  }, 60_000);

  it('BUDGET_DEFAULT_ENFORCEMENT=warn is honored', () => {
    const result = runWithEnv({ BUDGET_DEFAULT_ENFORCEMENT: 'warn' });
    expect(result.configValue).toBe('warn');
  }, 60_000);

  it('Unset env falls back to ignore', () => {
    const result = runWithEnv({}, ['BUDGET_DEFAULT_ENFORCEMENT']);
    expect(result.configValue).toBe('ignore');
  }, 60_000);

  it('Invalid env value falls back to ignore (whitelist)', () => {
    const result = runWithEnv({ BUDGET_DEFAULT_ENFORCEMENT: 'YOLO' });
    expect(result.configValue).toBe('ignore');
  }, 60_000);

  it('BUDGET_DEFAULT_THRESHOLD_PERCENT=80 is honored', () => {
    const result = runWithEnv({ BUDGET_DEFAULT_THRESHOLD_PERCENT: '80' });
    expect(result.thresholdConfig).toBe(80);
  }, 60_000);

  it('Threshold out of [1,200] range falls back to 100', () => {
    const result = runWithEnv({ BUDGET_DEFAULT_THRESHOLD_PERCENT: '500' });
    expect(result.thresholdConfig).toBe(100);
  }, 60_000);
});
