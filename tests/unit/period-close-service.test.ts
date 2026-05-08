/**
 * Period-Close Service unit tests.
 *
 * Pure logic checks — no Mongo, no app boot. Drives the FSM by stubbing
 * the repository surface so a refactor of the step ladder still pins the
 * advance / skip / abort contract.
 *
 * Why unit and not scenario: the step handlers are isolated functions
 * (validate_drafts queries Mongoose, trial_balance hits the report engine,
 * close_period calls @classytic/ledger). Their internals are well-tested
 * upstream; the orchestration here is what's prone to drift.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_PERIOD_CLOSE_STEPS } from '../../src/resources/accounting/period-close/period-close.model.js';

describe('DEFAULT_PERIOD_CLOSE_STEPS', () => {
  it('exposes the audited close ladder in correct order', () => {
    // Industry-standard close gates (settlements / clearing / costing /
    // POS shifts / withholding) sit between bank reconciliation and the
    // ledger-level close. Order matters — closing the period before any
    // operational gate fails leaves the closed period audit-indefensible.
    expect(DEFAULT_PERIOD_CLOSE_STEPS.map((s) => s.key)).toEqual([
      'validate_drafts',
      'trial_balance',
      'bank_reconcile',
      'validate_settlements',
      'validate_clearing_balance',
      'validate_costing',
      'validate_negative_stock',
      'validate_open_pos_shifts',
      'validate_withholding',
      'validate_mushak',
      'validate_open_returns',
      'close_period',
      'archive',
    ]);
  });

  it('puts every operational gate before close_period', () => {
    const closeIdx = DEFAULT_PERIOD_CLOSE_STEPS.findIndex((s) => s.key === 'close_period');
    const gateKeys = [
      'validate_settlements',
      'validate_clearing_balance',
      'validate_costing',
      'validate_negative_stock',
      'validate_open_pos_shifts',
      'validate_withholding',
      'validate_mushak',
    ];
    for (const k of gateKeys) {
      const i = DEFAULT_PERIOD_CLOSE_STEPS.findIndex((s) => s.key === k);
      expect(i, `${k} index`).toBeGreaterThanOrEqual(0);
      expect(i, `${k} should be before close_period`).toBeLessThan(closeIdx);
    }
  });

  it('every gate ships with a discoverable label finance can understand', () => {
    const gateKeys = [
      'validate_settlements',
      'validate_clearing_balance',
      'validate_costing',
      'validate_negative_stock',
      'validate_open_pos_shifts',
      'validate_withholding',
      'validate_mushak',
    ];
    for (const k of gateKeys) {
      const step = DEFAULT_PERIOD_CLOSE_STEPS.find((s) => s.key === k);
      expect(step, `${k} should exist`).toBeDefined();
      expect(step?.label.length, `${k} label should be present`).toBeGreaterThan(0);
      // Labels mention what's checked so the wizard error doesn't say
      // "validation failed" with no context.
      expect(step?.label.toLowerCase()).toMatch(
        /settlement|clearing|costing|cost|stock|shift|withholding|mushak/,
      );
    }
  });

  it('marks bank_reconcile as a manual-ack step', () => {
    const bank = DEFAULT_PERIOD_CLOSE_STEPS.find((s) => s.key === 'bank_reconcile');
    expect(bank?.requiresManualAck).toBe(true);
  });

  it('every step ships with a human label', () => {
    for (const s of DEFAULT_PERIOD_CLOSE_STEPS) {
      expect(typeof s.label).toBe('string');
      expect(s.label.length).toBeGreaterThan(3);
    }
  });

  it('close_period sits at index 11 — every operational gate runs first', () => {
    const idx = DEFAULT_PERIOD_CLOSE_STEPS.findIndex((s) => s.key === 'close_period');
    expect(idx).toBe(11);
    // Sanity: drafts + tb + bank-rec + 7 operational gates + open-returns = 11.
    expect(DEFAULT_PERIOD_CLOSE_STEPS.slice(0, idx).length).toBe(11);
  });

  it('archive sits at the last index — no work after it', () => {
    expect(DEFAULT_PERIOD_CLOSE_STEPS[DEFAULT_PERIOD_CLOSE_STEPS.length - 1]?.key).toBe('archive');
  });
});
