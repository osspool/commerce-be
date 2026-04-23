/**
 * Business-Type Posting Matrix (UNIT)
 *
 * Per testing-infrastructure.md §1: pure-function exercises live in the FAST
 * tier. This file calls the bd-vat resolver and be-prod posting-contract
 * functions directly — no Mongo, no Fastify, no app boot. Fast feedback on
 * the cross-package plumbing.
 *
 * The matching SCENARIO-tier integration tests (booted app, HTTP, end-state
 * GL assertions) live in `tests/integration/` alongside `musok-e2e.test.ts`
 * and the other replSet-required suites.
 *
 * Covers (one test block per business type):
 *   1. SME_TOT          — output goes to 2132.TOT4.COLLECTED, no input credit
 *   2. STANDARD_VAT     — full input credit on purchases, 9.1 output split by rate
 *   3. IMPORTER         — import stack (CD+SD+AT+VAT+AIT), AT non-claimable
 *   4. RMG_EXPORTER     — zero-rated export via fiscal position remap
 *   5. IT_SERVICES      — 5% ITES + zero-rated export
 *   6. SERVICE_PROVIDER — VDS deduction on corporate buyer payment
 *   7. COTTAGE_EXEMPT   — no VAT posting at all
 *
 * Plus edge matrix:
 *   - truncated-rate supplier (no input credit even though regime allows)
 *   - mixed invoice (VAT + exempt lines together)
 *   - foreign buyer remap (domestic STANDARD → ZERO_EXPORT)
 *   - NGO-without-certificate audit rejection
 *   - response shape regression — raw mongokit-style objects throughout
 */

import { describe, it, expect } from 'vitest';
import {
  createBdTaxResolver,
  calculateImportTaxStack,
  calculateVdsDeduction,
  calculateInvoiceTax,
  resolveBdTaxClass,
  getRegimeRule,
  type BusinessType,
} from '@classytic/bd-tax';
import { purchaseToPosting } from '../src/resources/accounting/posting/contracts/purchase.contract.js';
import { vendorBillToPosting } from '../src/resources/accounting/posting/contracts/vendor-bill.contract.js';
import { importClearanceToPosting } from '../src/resources/accounting/posting/contracts/import-clearance.contract.js';
import type { AccountingRegime } from '../src/resources/accounting/tax/tax-resolver.js';

const resolver = createBdTaxResolver();

// Helper — map BusinessType → AccountingRegime
function regimeFor(bt: BusinessType): AccountingRegime {
  switch (bt) {
    case 'SME_TOT':
      return 'tot';
    case 'COTTAGE_EXEMPT':
      return 'exempt';
    case 'IMPORTER':
      return 'importer';
    case 'RMG_EXPORTER':
      return 'rmg';
    case 'IT_SERVICES':
      return 'it';
    case 'SERVICE_PROVIDER':
      return 'service';
    default:
      return 'standard';
  }
}

// ── 1. SME_TOT ──────────────────────────────────────────────────────────────

describe('Regime: SME_TOT (turnover < 3cr, 4% TOT)', () => {
  const rule = getRegimeRule('SME_TOT');

  it('files Mushak 9.2, not 9.1', () => {
    expect(rule.filingForm).toBe('MUSHAK_9.2');
  });

  it('cannot claim input credit', () => {
    expect(rule.inputCreditEligible).toBe(false);
  });

  it('routes output to 2132.TOT4.COLLECTED regardless of rate', () => {
    const account = resolver.accountFor('STANDARD', 'output', 'tot');
    expect(account).toBe('2132.TOT4.COLLECTED');
  });

  it('returns null for input posting — no claim possible', () => {
    expect(resolver.accountFor('STANDARD', 'input', 'tot')).toBeNull();
  });

  it('purchase contract folds input VAT into inventory cost', () => {
    const posting = purchaseToPosting({
      purchaseId: 'PUR-1',
      supplierId: 'SUP-1',
      totalAmount: 115_00_000, // 1,15,000 BDT (gross incl 15% VAT)
      tax: 15_00_000, // 15,000 VAT
      vatRateCode: 'STANDARD',
      regime: 'tot',
      date: new Date('2026-04-15'),
      inventoryType: 'merchandise',
    });
    // No VAT line — all goes into inventory
    const vatLine = posting.items.find((i) => i.label?.includes('Input VAT'));
    expect(vatLine).toBeUndefined();
    const inventoryLine = posting.items.find((i) => i.accountCode.startsWith('116'));
    expect(inventoryLine?.debit).toBe(115_00_000); // Full gross
  });
});

// ── 2. STANDARD_VAT ─────────────────────────────────────────────────────────

describe('Regime: STANDARD_VAT (> 3cr, full reconciliation)', () => {
  const rule = getRegimeRule('STANDARD_VAT');

  it('files Mushak 9.1 with full input credit', () => {
    expect(rule.filingForm).toBe('MUSHAK_9.1');
    expect(rule.inputCreditEligible).toBe(true);
    expect(rule.vdsWithholdingApplicable).toBe(true);
  });

  it('routes standard output to 2132.VAT15.COLLECTED', () => {
    expect(resolver.accountFor('STANDARD', 'output', 'standard')).toBe('2132.VAT15.COLLECTED');
  });

  it('routes standard input to 1150.VAT15.INPUT', () => {
    expect(resolver.accountFor('STANDARD', 'input', 'standard')).toBe('1150.VAT15.INPUT');
  });

  it('purchase contract splits gross into inventory (net) + input VAT', () => {
    const posting = purchaseToPosting({
      purchaseId: 'PUR-2',
      supplierId: 'SUP-2',
      totalAmount: 115_00_000,
      tax: 15_00_000,
      vatRateCode: 'STANDARD',
      regime: 'standard',
      date: new Date('2026-04-15'),
      inventoryType: 'merchandise',
    });
    const vatLine = posting.items.find((i) => i.label?.includes('Input VAT'));
    expect(vatLine?.debit).toBe(15_00_000);
    expect(vatLine?.accountCode).toBe('1150.VAT15.INPUT');
    const inventoryLine = posting.items.find((i) => i.accountCode.startsWith('116'));
    expect(inventoryLine?.debit).toBe(100_00_000); // Net
  });

  it('vendor bill (accrual path) also splits input VAT correctly', () => {
    const posting = vendorBillToPosting({
      purchaseId: 'PUR-3',
      supplierId: 'SUP-3',
      totalAmount: 115_00_000,
      tax: 15_00_000,
      vatRateCode: 'STANDARD',
      regime: 'standard',
      receivedAt: new Date('2026-04-15'),
      creditDays: 30,
    });
    const vatLine = posting.items.find((i) => i.accountCode === '1150.VAT15.INPUT');
    expect(vatLine?.debit).toBe(15_00_000);
    const apLine = posting.items.find((i) => i.accountCode === '2111');
    expect(apLine?.credit).toBe(115_00_000);
  });
});

// ── 3. IMPORTER ─────────────────────────────────────────────────────────────

describe('Regime: IMPORTER (CD + SD + AT + VAT + AIT stack)', () => {
  it('stacks taxes in NBR-mandated sequence', () => {
    const stack = calculateImportTaxStack({
      assessableValue: 1_00_00_000, // 1 lakh BDT
      cdRate: 10,
      sdRate: 0,
      atRate: 5,
      vatRate: 15,
      aitRate: 5,
    });
    expect(stack.customsDuty).toBe(10_00_000);
    // AT = 5% of (AV + CD + SD) = 5% of 1_10_00_000 = 5_50_000
    expect(stack.advanceTax).toBe(5_50_000);
    // VAT = 15% of (AV + CD + SD + AT) = 15% of 1_15_50_000 = 17_32_500
    expect(stack.vat).toBe(17_32_500);
    // AIT = 5% of AV = 5_00_000
    expect(stack.advanceIncomeTax).toBe(5_00_000);
    // Landed = AV + CD + SD
    expect(stack.landedInventoryCost).toBe(1_10_00_000);
  });

  it('import-clearance contract posts VAT to 1150 (claimable)', () => {
    const posting = importClearanceToPosting({
      clearanceId: 'BOE-1',
      supplierId: 'SUP-FOREIGN',
      assessableValue: 1_00_00_000,
      cdRate: 10,
      regime: 'importer',
      date: new Date('2026-04-15'),
      inventoryType: 'merchandise',
    });
    const vatLine = posting.items.find((i) => i.accountCode === '1150.VAT15.INPUT');
    expect(vatLine).toBeDefined();
    expect(vatLine!.debit).toBeGreaterThan(0);
  });

  it('import-clearance routes AT + AIT to 1151 (non-claimable as VAT)', () => {
    const posting = importClearanceToPosting({
      clearanceId: 'BOE-2',
      supplierId: 'SUP-FOREIGN',
      assessableValue: 1_00_00_000,
      cdRate: 10,
      regime: 'importer',
      date: new Date('2026-04-15'),
    });
    const aitLine = posting.items.find((i) => i.accountCode === '1151');
    expect(aitLine).toBeDefined();
    // AT (5% of AV+CD+SD = 5_50_000) + AIT (5% of AV = 5_00_000) = 10_50_000
    expect(aitLine!.debit).toBe(10_50_000);
  });

  it('import-clearance for TOT regime folds VAT into inventory cost', () => {
    const posting = importClearanceToPosting({
      clearanceId: 'BOE-3',
      supplierId: 'SUP-FOREIGN',
      assessableValue: 1_00_00_000,
      cdRate: 10,
      regime: 'tot',
      date: new Date('2026-04-15'),
    });
    const vatLine = posting.items.find((i) => i.accountCode === '1150.VAT15.INPUT');
    expect(vatLine).toBeUndefined(); // No claimable line
    const inventoryLine = posting.items.find((i) => i.accountCode.startsWith('116'));
    // Inventory = landed cost (1_10_00_000) + VAT (folded, 16_50_000) — computed
    // from the AV+CD+AT base (not the AV+CD stack the claimable path uses).
    expect(inventoryLine!.debit).toBeGreaterThan(1_10_00_000);
  });
});

// ── 4. RMG_EXPORTER — fiscal-position zero-rate ────────────────────────────

describe('Regime: RMG_EXPORTER (zero-rated export via fiscal position)', () => {
  it('foreign buyer → INTERNATIONAL position, STANDARD remapped to ZERO_EXPORT', () => {
    const fp = resolver.resolveFiscalPosition(
      { countryCode: 'US' },
      { countryCode: 'BD' },
    );
    expect(fp.position).toBe('INTERNATIONAL');
    expect(fp.mapTaxClass('STANDARD')).toBe('ZERO_EXPORT');
    expect(fp.reference).toContain('EXPORT-US');
    expect(fp.reason).toMatch(/Export/);
  });

  it('utility supplier → RMG factory remaps to RMG_UTILITY (exempt)', () => {
    const fp = resolver.resolveFiscalPosition(
      { countryCode: 'BD', isRmgFactory: true },
      { countryCode: 'BD', suppliesUtility: true },
    );
    expect(fp.position).toBe('RMG_UTILITY');
    expect(fp.reference).toBe('SRO-190/2023');
  });

  it('exporter regime supports zero-rated exports', () => {
    expect(getRegimeRule('RMG_EXPORTER').supportsZeroRatedExport).toBe(true);
    expect(getRegimeRule('RMG_EXPORTER').bondedWarehouseEligible).toBe(true);
  });
});

// ── 5. IT_SERVICES ──────────────────────────────────────────────────────────

describe('Regime: IT_SERVICES (5% ITES domestic + zero-rated export)', () => {
  it('files Mushak 9.1 with input credit', () => {
    const rule = getRegimeRule('IT_SERVICES');
    expect(rule.filingForm).toBe('MUSHAK_9.1');
    expect(rule.inputCreditEligible).toBe(true);
    expect(rule.supportsZeroRatedExport).toBe(true);
  });

  it('SEZ unit receiving utility → SEZ_BHTC_UTILITY rebate position', () => {
    const fp = resolver.resolveFiscalPosition(
      { countryCode: 'BD', isSezUnit: true },
      { countryCode: 'BD', suppliesUtility: true },
    );
    expect(fp.position).toBe('SEZ_BHTC_UTILITY');
    expect(fp.reference).toBe('SRO-186/2023');
  });

  it('resolves REDUCED_5 tax class for domestic ITES services', () => {
    const rate = resolveBdTaxClass('REDUCED_5');
    expect(rate?.rate).toBe(5);
    expect(rate?.inputCreditAllowed).toBe(false); // Truncated rate
  });
});

// ── 6. SERVICE_PROVIDER — VDS deduction ────────────────────────────────────

describe('Regime: SERVICE_PROVIDER (VDS withheld by corporate buyer)', () => {
  it('computes 15% VDS on professional consulting billed to CORP', () => {
    const result = calculateVdsDeduction({
      serviceValue: 100_000_00, // 1 lakh BDT
      vatAmount: 15_000_00,
      payerCategory: 'CORP',
      serviceCategory: 'PROFESSIONAL_CONSULTING',
    });
    expect(result).not.toBeNull();
    expect(result!.vdsRate).toBe(15);
    expect(result!.vdsAmount).toBe(15_000_00);
    // Net to supplier = 100k + 15k VAT - 15k VDS = 100k
    expect(result!.netPayable).toBe(100_000_00);
  });

  it('5% VDS on IT/software services to CORP buyer', () => {
    const result = calculateVdsDeduction({
      serviceValue: 200_000_00,
      vatAmount: 10_000_00, // 5% VAT
      payerCategory: 'CORP',
      serviceCategory: 'IT_SOFTWARE',
    });
    expect(result!.vdsRate).toBe(5);
    expect(result!.vdsAmount).toBe(10_000_00);
  });

  it('returns null when matrix has no entry for the combination', () => {
    const result = calculateVdsDeduction({
      serviceValue: 100_000_00,
      vatAmount: 15_000_00,
      payerCategory: 'TELECOM',
      serviceCategory: 'IT_SOFTWARE',
    });
    expect(result).toBeNull();
  });
});

// ── 7. COTTAGE_EXEMPT ──────────────────────────────────────────────────────

describe('Regime: COTTAGE_EXEMPT (below 50L threshold)', () => {
  const rule = getRegimeRule('COTTAGE_EXEMPT');

  it('files nothing', () => {
    expect(rule.filingForm).toBe('NONE');
  });

  it('no VAT mechanics at all', () => {
    expect(rule.inputCreditEligible).toBe(false);
    expect(rule.vdsWithholdingApplicable).toBe(false);
  });

  it('accountFor returns null for all directions', () => {
    expect(resolver.accountFor('STANDARD', 'output', 'exempt')).toBeNull();
    expect(resolver.accountFor('STANDARD', 'input', 'exempt')).toBeNull();
  });

  it('purchase contract still posts inventory + A/P but no VAT split', () => {
    const posting = purchaseToPosting({
      purchaseId: 'PUR-COT',
      supplierId: 'SUP-COT',
      totalAmount: 10_000_00,
      tax: 0,
      regime: 'exempt',
      date: new Date('2026-04-15'),
    });
    const vatLine = posting.items.find((i) => i.label?.includes('Input VAT'));
    expect(vatLine).toBeUndefined();
  });
});

// ── Edge cases — cross-cutting ─────────────────────────────────────────────

describe('Edge: truncated-rate supplier (5/7.5/10% no input credit)', () => {
  it('REDUCED_5 input returns null — folds to inventory', () => {
    expect(resolver.accountFor('REDUCED_5', 'input', 'standard')).toBeNull();
  });

  it('REDUCED_10 input returns null', () => {
    expect(resolver.accountFor('REDUCED_10', 'input', 'standard')).toBeNull();
  });

  it('but REDUCED_5 output still posts to 2132.VAT5.COLLECTED', () => {
    expect(resolver.accountFor('REDUCED_5', 'output', 'standard')).toBe('2132.VAT5.COLLECTED');
  });

  it('purchase from truncated-rate supplier folds VAT into inventory', () => {
    const posting = purchaseToPosting({
      purchaseId: 'PUR-TRUNC',
      supplierId: 'SUP-TRUNC',
      totalAmount: 105_00_000, // 5% VAT supplier
      tax: 5_00_000,
      vatRateCode: 'REDUCED_5',
      regime: 'standard',
      date: new Date('2026-04-15'),
    });
    const vatLine = posting.items.find((i) => i.label?.includes('Input VAT'));
    expect(vatLine).toBeUndefined();
    const inventoryLine = posting.items.find((i) => i.accountCode.startsWith('116'));
    expect(inventoryLine?.debit).toBe(105_00_000); // Full gross folded in
  });
});

describe('Edge: mixed-line invoice (VAT + exempt on same Mushak 6.3)', () => {
  it('calculateInvoiceTax returns per-line VAT correctly', () => {
    const { summary, lines } = calculateInvoiceTax([
      { description: 'Taxable item', quantity: 1, unitPrice: 100_000, vatRateCode: 'STANDARD' },
      { description: 'Exempt rice', quantity: 1, unitPrice: 50_000, vatRateCode: 'EXEMPT' },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0].vatAmount).toBe(15_000); // 15% of 100k
    expect(lines[1].vatAmount).toBe(0); // Exempt
    expect(summary.totalVat).toBe(15_000);
    expect(summary.subtotal).toBe(150_000);
  });
});

describe('Edge: foreign buyer remap (domestic STANDARD → ZERO_EXPORT)', () => {
  it('resolver returns INTERNATIONAL fiscal position', () => {
    const fp = resolver.resolveFiscalPosition(
      { countryCode: 'DE', name: 'German buyer' },
      { countryCode: 'BD' },
    );
    expect(fp.position).toBe('INTERNATIONAL');
    expect(fp.mapTaxClass('STANDARD')).toBe('ZERO_EXPORT');
    expect(fp.mapTaxClass('EXEMPT_STAPLE')).toBe('EXEMPT_STAPLE'); // Already non-charging
  });
});

describe('Edge: NGO without exemption certificate is flagged for rejection', () => {
  it('returns the audit-fail reason without a reference', () => {
    const fp = resolver.resolveFiscalPosition(
      { countryCode: 'BD', isExemptNgo: true /* no exemptionCertificate */ },
      { countryCode: 'BD' },
    );
    expect(fp.position).toBe('EXEMPT_NGO');
    expect(fp.reference).toBeUndefined();
    expect(fp.reason).toContain('POSTING MUST BE REJECTED');
  });

  it('NGO WITH certificate passes with the certificate as reference', () => {
    const fp = resolver.resolveFiscalPosition(
      {
        countryCode: 'BD',
        isExemptNgo: true,
        exemptionCertificate: 'NGO-CERT-2026-42',
      },
      { countryCode: 'BD' },
    );
    expect(fp.reference).toBe('NGO-CERT-2026-42');
  });
});

// ── Response-shape regression gate ─────────────────────────────────────────

describe('Response-shape regression: posting contracts return PostingInput shape', () => {
  it('purchaseToPosting returns { journalType, label, date, items, idempotencyKey, sourceRef }', () => {
    const p = purchaseToPosting({
      purchaseId: 'SHAPE-1',
      supplierId: 'S-1',
      totalAmount: 115_00_000,
      tax: 15_00_000,
      vatRateCode: 'STANDARD',
      date: new Date('2026-04-15'),
    });
    // Raw shape — no envelope, no wrapping, no data.* nesting.
    expect(p).toHaveProperty('journalType', 'PURCHASES');
    expect(p).toHaveProperty('label');
    expect(p).toHaveProperty('date');
    expect(Array.isArray(p.items)).toBe(true);
    expect(p).toHaveProperty('idempotencyKey');
    expect(p.sourceRef).toEqual({ sourceModel: 'PurchaseOrder', sourceId: 'SHAPE-1' });
  });

  it('importClearanceToPosting returns the same PostingInput shape', () => {
    const p = importClearanceToPosting({
      clearanceId: 'SHAPE-2',
      supplierId: 'S-F',
      assessableValue: 1_00_00_000,
      cdRate: 10,
      date: new Date('2026-04-15'),
    });
    expect(p).toHaveProperty('journalType', 'PURCHASES');
    expect(p.sourceRef).toEqual({ sourceModel: 'ImportClearance', sourceId: 'SHAPE-2' });
    // Each item has { accountCode, debit, credit, label? } — no nested envelope
    for (const item of p.items) {
      expect(item).toHaveProperty('accountCode');
      expect(item).toHaveProperty('debit');
      expect(item).toHaveProperty('credit');
    }
  });

  it('resolver returns plain object shape (no Promise, no wrapping)', () => {
    const rate = resolver.resolveClass('STANDARD');
    expect(rate).toHaveProperty('rateCode', 'STANDARD');
    expect(rate).toHaveProperty('rate', 15);
    expect(rate).toHaveProperty('inputCreditAllowed', true);
  });

  it('fiscal position result carries audit trail', () => {
    const fp = resolver.resolveFiscalPosition(
      { countryCode: 'BD' },
      { countryCode: 'BD' },
    );
    expect(fp).toHaveProperty('position', 'NATIONAL');
    expect(fp).toHaveProperty('reason');
    expect(fp).toHaveProperty('mapTaxClass');
    expect(typeof fp.mapTaxClass).toBe('function');
  });
});
