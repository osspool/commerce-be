/**
 * Invoice Engine Configuration
 *
 * Controls the @classytic/invoice integration.
 * Master switch: INVOICE_ENGINE (defaults to true).
 *
 * Auto-invoicing policies (Odoo-inspired):
 *   - INVOICE_AUTO_SALES:    'off' | 'on_order' | 'on_payment'
 *   - INVOICE_AUTO_PURCHASE: 'off' | 'on_receive'
 *   - INVOICE_AUTO_POS:      'off' | 'receipt_per_day' | 'receipt_per_txn'
 *
 * Dunning (payment reminders):
 *   - INVOICE_DUNNING_SCHEDULE: days relative to due date (-3,0,7,14,30)
 *   - INVOICE_DUNNING_GRACE_DAYS: grace period before first overdue flag
 *
 * Optional bridges:
 *   - INVOICE_NOTIFICATIONS: enable sending invoice emails via @classytic/notifications
 *   - INVOICE_PDF: enable PDF generation (requires PDFBridge implementation)
 */

type AutoSalesPolicy = 'off' | 'on_order' | 'on_payment';
type AutoPurchasePolicy = 'off' | 'on_receive';
type AutoPosPolicy = 'off' | 'receipt_per_day' | 'receipt_per_txn';

const VALID_SALES: AutoSalesPolicy[] = ['off', 'on_order', 'on_payment'];
const VALID_PURCHASE: AutoPurchasePolicy[] = ['off', 'on_receive'];
const VALID_POS: AutoPosPolicy[] = ['off', 'receipt_per_day', 'receipt_per_txn'];

function parseEnum<T extends string>(value: string | undefined, valid: T[], fallback: T): T {
  if (value && valid.includes(value as T)) return value as T;
  return fallback;
}

function parseDunningSchedule(raw: string | undefined): number[] {
  if (!raw) return [-3, 0, 7, 14, 30];
  return raw
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n));
}

export interface InvoiceConfigSection {
  invoice: {
    engine: boolean;
    autoSales: AutoSalesPolicy;
    autoPurchase: AutoPurchasePolicy;
    autoPOS: AutoPosPolicy;
    dunningSchedule: number[];
    dunningGraceDays: number;
    notifications: boolean;
    pdf: boolean;
    approvalEnabled: boolean;
    approvalAutoApproveBelow: number | undefined;
    lateFeeEnabled: boolean;
    lateFeeRate: number;
    lateFeePeriod: 'daily' | 'monthly' | 'once';
    lateFeeMaxFee: number | undefined;
    lateFeeGraceDays: number;
  };
}

const invoice: InvoiceConfigSection['invoice'] = {
  engine: process.env.INVOICE_ENGINE !== 'false',
  autoSales: parseEnum(process.env.INVOICE_AUTO_SALES, VALID_SALES, 'off'),
  autoPurchase: parseEnum(process.env.INVOICE_AUTO_PURCHASE, VALID_PURCHASE, 'off'),
  autoPOS: parseEnum(process.env.INVOICE_AUTO_POS, VALID_POS, 'off'),
  dunningSchedule: parseDunningSchedule(process.env.INVOICE_DUNNING_SCHEDULE),
  dunningGraceDays: parseInt(process.env.INVOICE_DUNNING_GRACE_DAYS || '3', 10),
  notifications: process.env.INVOICE_NOTIFICATIONS === 'true',
  pdf: process.env.INVOICE_PDF === 'true',
  approvalEnabled: process.env.INVOICE_APPROVAL === 'true',
  approvalAutoApproveBelow: process.env.INVOICE_APPROVAL_AUTO_BELOW
    ? parseInt(process.env.INVOICE_APPROVAL_AUTO_BELOW, 10)
    : undefined,
  lateFeeEnabled: process.env.INVOICE_LATE_FEE === 'true',
  lateFeeRate: parseFloat(process.env.INVOICE_LATE_FEE_RATE || '0.02'),
  lateFeePeriod: parseEnum(process.env.INVOICE_LATE_FEE_PERIOD, ['daily', 'monthly', 'once'], 'monthly'),
  lateFeeMaxFee: process.env.INVOICE_LATE_FEE_MAX ? parseInt(process.env.INVOICE_LATE_FEE_MAX, 10) : undefined,
  lateFeeGraceDays: parseInt(process.env.INVOICE_LATE_FEE_GRACE_DAYS || '5', 10),
};

const invoiceConfig: InvoiceConfigSection = { invoice };

export default invoiceConfig;
