/**
 * Accounting Configuration
 *
 * Single switch — `enabled`. The full accounting feature set ships when on:
 * chart of accounts, journals, journal entries, budgets, reconciliation,
 * auto-posting from POS / orders / inventory, reports.
 *
 * Hiding individual features (e.g. budgets from a small-shop tenant who
 * doesn't care) belongs in the FE/permissions layer, NOT here. We removed
 * the previous `mode: 'simple' | 'standard' | 'enterprise'` gate after it
 * sprawled across 7 files of conditional code without serving a real
 * single-tenant deployment.
 */

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
    /** Fiscal year start month (1-12). BD default: 7 (July). */
    fiscalYearStartMonth: number;
    /** Auto-seed chart of accounts on first branch access. */
    autoSeedAccounts: boolean;
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
  fiscalYearStartMonth: parseInt(process.env.FISCAL_YEAR_START_MONTH || '7', 10),
  autoSeedAccounts: process.env.ACCOUNTING_AUTO_SEED !== 'false',
  extraTaxClasses: [],
};

const accountingConfig: AccountingConfigSection = { accounting };

export default accountingConfig;
