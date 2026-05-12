/**
 * Withholding Certificate Auto-Generation Helpers (gap #10)
 *
 * Pure functions for building certificate data from JE context.
 * Called by postBillAction after a vendor bill with VDS is posted.
 */

export interface AutoCertParams {
  organizationId: string;
  supplierId: string;
  purchaseId: string;
  journalEntryId: string;
  grossAmount: number;
  vdsRate: number;
  vdsAmount: number;
  date: Date;
  supplierTin?: string;
  supplierName?: string;
}

export function buildCertificateNumber(journalEntryId: string, date: Date): string {
  const yyyymm = date.toISOString().slice(0, 7).replace('-', '');
  return `VDS-${yyyymm}-${journalEntryId.slice(-8)}`;
}

export function buildCertificateData(params: AutoCertParams): Record<string, unknown> {
  return {
    organizationId: params.organizationId,
    type: 'VDS',
    direction: 'ISSUED',
    certificateNumber: buildCertificateNumber(params.journalEntryId, params.date),
    certificateDate: params.date,
    period: params.date.toISOString().slice(0, 7),
    counterpartyTin: params.supplierTin ?? 'UNKNOWN',
    counterpartyName: params.supplierName ?? 'UNKNOWN',
    grossAmount: params.grossAmount,
    rate: params.vdsRate * 100,
    withholdingAmount: params.vdsAmount,
    netPaid: params.grossAmount - params.vdsAmount,
    journalEntryId: params.journalEntryId,
    sourceId: params.purchaseId,
    sourceModel: 'PurchaseOrder',
    reconciled: false,
  };
}
