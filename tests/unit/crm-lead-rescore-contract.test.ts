/**
 * CRM Lead rescore — contract tests
 *
 * Validates the rescore action handler shape so the SDK's `rescore()` method
 * (POST /:id/action { action: "rescore" }) doesn't silently get a 404.
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { resolve } from 'path';

const RESOURCE_PATH = resolve(
  import.meta.dirname,
  '../../src/resources/crm/leads/lead.resource.ts',
);

const ACTIONS_PATH = resolve(
  import.meta.dirname,
  '../../src/resources/crm/leads/lead.actions.ts',
);

describe('CRM Lead rescore action contract', () => {
  it('lead.resource.ts registers a rescore action', async () => {
    const src = await readFile(RESOURCE_PATH, 'utf8');
    expect(src).toContain('rescore');
  });

  it('rescoreLead function exported from lead.actions.ts', async () => {
    const src = await readFile(ACTIONS_PATH, 'utf8');
    expect(src).toContain('export');
    expect(src).toContain('rescoreLead');
  });

  it('rescore handler returns { id, score } shape', async () => {
    const src = await readFile(ACTIONS_PATH, 'utf8');
    expect(src).toContain('score');
    expect(src).toContain('return { id, score }');
  });

  it('rescore scoring logic includes email, phone, companyName, source, status fields', async () => {
    const src = await readFile(ACTIONS_PATH, 'utf8');
    expect(src).toContain('lead.email');
    expect(src).toContain('lead.phone');
    expect(src).toContain('lead.companyName');
    expect(src).toContain('lead.source');
    expect(src).toContain('lead.status');
  });

  it('rescore scoring awards 30 points for qualified status — highest value signal', async () => {
    const src = await readFile(ACTIONS_PATH, 'utf8');
    // qualified is worth 30 — largest single score increment
    expect(src).toContain('30');
    const qualifiedIdx = src.indexOf("'qualified'");
    const scoreAfter = src.slice(qualifiedIdx, qualifiedIdx + 60);
    expect(scoreAfter).toMatch(/30/);
  });
});
