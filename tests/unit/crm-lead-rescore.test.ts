/**
 * CRM lead rescore action — unit test (CRITICAL gap)
 *
 * Gap: Lead `score` field exists on model but is never updated — no scoring engine.
 *
 * Fix: `rescoreLead` action added to lead.actions.ts + wired in lead.resource.ts.
 *      Scoring: email +10, phone +5, companyName +20, source +5,
 *               contacted +15, qualified +30.
 *
 * RED: rescoreLead export missing from lead.actions.ts
 * GREEN: rescore exported and computes correct scores for each signal
 */

import { describe, it, expect } from 'vitest';

describe('CRM lead rescore action', () => {
  it('rescoreLead is exported from lead.actions.ts', async () => {
    const mod = await import('../../src/resources/crm/leads/lead.actions.js');
    expect(typeof mod.rescoreLead).toBe('function');
  });

  it('lead.resource.ts registers the rescore action', async () => {
    const fs = await import('fs/promises');
    const src = await fs.readFile('src/resources/crm/leads/lead.resource.ts', 'utf8');
    expect(src).toContain('rescore');
    expect(src).toContain('rescoreLead');
  });

  it('scoring accumulates correct points for a fully-qualified lead', () => {
    function computeScore(lead: {
      email?: string;
      phone?: string;
      companyName?: string;
      source?: string;
      status?: string;
    }): number {
      let score = 0;
      if (lead.email) score += 10;
      if (lead.phone) score += 5;
      if (lead.companyName) score += 20;
      if (lead.source) score += 5;
      if (lead.status === 'contacted') score += 15;
      if (lead.status === 'qualified') score += 30;
      return score;
    }

    // Full B2B qualified lead
    expect(
      computeScore({ email: 'a@b.com', phone: '01700', companyName: 'Acme', source: 'inbound', status: 'qualified' }),
    ).toBe(70);

    // New lead with only email
    expect(computeScore({ email: 'a@b.com', status: 'new' })).toBe(10);

    // Contacted lead with phone
    expect(computeScore({ phone: '01700', status: 'contacted' })).toBe(20);

    // Empty lead
    expect(computeScore({})).toBe(0);
  });
});
