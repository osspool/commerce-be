/**
 * Accounting Configuration
 *
 * Controls the accounting/finance module.
 * Feature-gated: set ENABLE_ACCOUNTING=false to disable entirely.
 *
 * ACCOUNTING_MODE:
 *   - simple:     Manual journal entries only. No auto-posting from POS/orders.
 *   - standard:   Auto-posts from POS daily sales, purchases, and inventory adjustments.
 *   - enterprise: Full reconciliation, budgets, multi-currency, approval workflows.
 */

type AccountingMode = 'simple' | 'standard' | 'enterprise';

const VALID_MODES: AccountingMode[] = ['simple', 'standard', 'enterprise'];

function parseMode(value: string | undefined): AccountingMode {
  if (value && VALID_MODES.includes(value as AccountingMode)) {
    return value as AccountingMode;
  }
  return 'standard';
}

export interface ExtraTaxClassEntry {
  code: string;
  rate: {
    rateCode: string;
    rate: number;
    inputCreditAllowed: boolean;
    mushakGridOutput?: number;
    meta?: Record<string, unknown>;
  };
}

export interface AccountingConfigSection {
  accounting: {
    enabled: boolean;
    mode: AccountingMode;
    /** Fiscal year start month (1-12). BD default: 7 (July). */
    fiscalYearStartMonth: number;
    /** Auto-seed chart of accounts on first branch access. */
    autoSeedAccounts: boolean;
    /** Auto-post journal entries from POS/orders (standard+ mode). */
    autoPost: boolean;
    /**
     * Additive tax classes merged on top of the country pack's seed at
     * engine bootstrap. Populate when a deployment is granted a custom SRO
     * exemption the published bd-vat doesn't yet recognize — a one-line
     * entry here instead of patching the npm package.
     */
    extraTaxClasses: ExtraTaxClassEntry[];
  };
}

const accounting: AccountingConfigSection['accounting'] = {
  enabled: process.env.ENABLE_ACCOUNTING !== 'false',
  mode: parseMode(process.env.ACCOUNTING_MODE),
  fiscalYearStartMonth: parseInt(process.env.FISCAL_YEAR_START_MONTH || '7', 10),
  autoSeedAccounts: process.env.ACCOUNTING_AUTO_SEED !== 'false',
  autoPost: process.env.ACCOUNTING_AUTO_POST !== 'false',
  extraTaxClasses: [],
};

const accountingConfig: AccountingConfigSection = { accounting };

export default accountingConfig;
