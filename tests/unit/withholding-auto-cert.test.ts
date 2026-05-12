/**
 * Withholding certificate auto-generation — unit test (gap #10)
 *
 * Gap: WithholdingCertificate is CRUD-only — no auto-generation from JEs.
 * Fix: extract buildCertificateData() helper that `postBillAction` calls after
 *      posting a vendor bill with withholdVds=true.
 *
 * RED: buildCertificateData is not exported from vendor-bill.actions.ts
 * GREEN: add helper + wire in postBillAction
 */

import { describe, it, expect } from 'vitest';

describe('buildCertificateData — VDS auto-cert helper (gap #10)', () => {
  it('generates a stable VDS-YYYYMM-JEID certificate number', async () => {
    const { buildCertificateNumber } = await import(
      '../../src/resources/accounting/withholding/withholding-certificate.auto.js'
    );
    const date = new Date('2026-05-11');
    const jeId = 'abcdef1234567890';
    const num = buildCertificateNumber(jeId, date);
    expect(num).toBe('VDS-202605-34567890');
  });

  it('builds a complete certificate data object', async () => {
    const { buildCertificateData } = await import(
      '../../src/resources/accounting/withholding/withholding-certificate.auto.js'
    );
    const params = {
      organizationId: 'org-1',
      supplierId: 'sup-1',
      purchaseId: 'po-123',
      journalEntryId: 'je-abcdef0000001234',
      grossAmount: 10000,   // 100 BDT VAT in paisa
      vdsRate: 0.5,         // 50%
      vdsAmount: 5000,
      date: new Date('2026-05-11'),
      supplierTin: 'BIN-1234567',
      supplierName: 'Test Supplier Ltd',
    };
    const cert = buildCertificateData(params);

    expect(cert.type).toBe('VDS');
    expect(cert.direction).toBe('ISSUED');
    expect(cert.certificateNumber).toBe('VDS-202605-00001234');
    expect(cert.period).toBe('2026-05');
    expect(cert.counterpartyTin).toBe('BIN-1234567');
    expect(cert.counterpartyName).toBe('Test Supplier Ltd');
    expect(cert.grossAmount).toBe(10000);
    expect(cert.rate).toBe(50);
    expect(cert.withholdingAmount).toBe(5000);
    expect(cert.netPaid).toBe(5000);
    expect(cert.journalEntryId).toBe('je-abcdef0000001234');
    expect(cert.sourceId).toBe('po-123');
    expect(cert.sourceModel).toBe('PurchaseOrder');
    expect(cert.reconciled).toBe(false);
  });

  it('falls back to UNKNOWN for missing supplier info', async () => {
    const { buildCertificateData } = await import(
      '../../src/resources/accounting/withholding/withholding-certificate.auto.js'
    );
    const params = {
      organizationId: 'org-1',
      supplierId: 'sup-1',
      purchaseId: 'po-999',
      journalEntryId: 'je-0000000000000001',
      grossAmount: 5000,
      vdsRate: 0.5,
      vdsAmount: 2500,
      date: new Date('2026-05-11'),
    };
    const cert = buildCertificateData(params);
    expect(cert.counterpartyTin).toBe('UNKNOWN');
    expect(cert.counterpartyName).toBe('UNKNOWN');
  });
});
