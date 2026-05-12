/**
 * Budget enforcement company-wide default — contract tests
 *
 * Validates that the `BUDGET_DEFAULT_ENFORCEMENT` env var actually drives
 * the Budget schema default — not just a config knob that's defined but
 * never wired.
 */

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { resolve } from 'path';

const CONFIG_PATH = resolve(
  import.meta.dirname,
  '../../src/config/sections/accounting.config.ts',
);
const ENGINE_PATH = resolve(
  import.meta.dirname,
  '../../src/resources/accounting/accounting.engine.ts',
);

describe('Budget default enforcement contract', () => {
  it('accounting config exposes BudgetEnforcementMode type', async () => {
    const src = await readFile(CONFIG_PATH, 'utf8');
    expect(src).toContain("export type BudgetEnforcementMode = 'stop' | 'warn' | 'ignore'");
  });

  it('accounting config has budget.defaultActionIfExceeded field', async () => {
    const src = await readFile(CONFIG_PATH, 'utf8');
    expect(src).toContain('defaultActionIfExceeded');
    expect(src).toContain('defaultThresholdPercent');
  });

  it('config reads BUDGET_DEFAULT_ENFORCEMENT env var', async () => {
    const src = await readFile(CONFIG_PATH, 'utf8');
    expect(src).toContain('BUDGET_DEFAULT_ENFORCEMENT');
    expect(src).toContain('BUDGET_DEFAULT_THRESHOLD_PERCENT');
  });

  it('config falls back to ignore when env is unset or invalid', async () => {
    const src = await readFile(CONFIG_PATH, 'utf8');
    // parseEnforcementMode must whitelist exactly the three modes
    expect(src).toContain("raw === 'stop' || raw === 'warn' || raw === 'ignore'");
    expect(src).toContain("return 'ignore'");
  });

  it('config clamps threshold percent to [1, 200]', async () => {
    const src = await readFile(CONFIG_PATH, 'utf8');
    expect(src).toContain('n >= 1 && n <= 200');
  });

  it('Budget schema default is wired from config (not hardcoded ignore)', async () => {
    const src = await readFile(ENGINE_PATH, 'utf8');
    expect(src).toContain('config.accounting.budget.defaultActionIfExceeded');
    expect(src).toContain('config.accounting.budget.defaultThresholdPercent');
    // The OLD hardcoded literals must NOT appear inside the Budget schema
    // block — easiest way is to confirm we're not regressing to the
    // pre-fix shape: `default: 'ignore'` followed by `default: 100`.
    const actionIdx = src.indexOf('actionIfExceeded:');
    const thresholdIdx = src.indexOf('thresholdPercent:');
    expect(actionIdx).toBeGreaterThan(0);
    expect(thresholdIdx).toBeGreaterThan(actionIdx);
    const block = src.slice(actionIdx, thresholdIdx + 200);
    expect(block).not.toMatch(/default: 'ignore',\s*\n/); // hardcoded literal removed
  });
});

describe('Budget enforcement plugin still respects per-budget override', () => {
  it('plugin filters by actionIfExceeded !== ignore (per-budget wins)', async () => {
    const pluginPath = resolve(
      import.meta.dirname,
      '../../src/resources/accounting/posting/budget-enforcement-plugin.ts',
    );
    const src = await readFile(pluginPath, 'utf8');
    // The Mongo filter must respect each budget's own actionIfExceeded,
    // not the company-wide default. (Default fills NEW budgets; existing
    // budgets keep whatever they were created with.)
    expect(src).toContain("actionIfExceeded: { $ne: 'ignore' }");
    expect(src).toContain("budget.actionIfExceeded === 'stop'");
  });
});
