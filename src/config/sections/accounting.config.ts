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

export type BudgetEnforcementMode = 'stop' | 'warn' | 'ignore';

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
    budget: {
      /**
       * Company-wide default enforcement mode for new budgets.
       *   - `stop`   — block JE post that would overage the threshold
       *   - `warn`   — log + emit `budget.threshold.exceeded`, post anyway
       *   - `ignore` — informational only (legacy default)
       * Per-budget `actionIfExceeded` overrides this. Driven by
       * BUDGET_DEFAULT_ENFORCEMENT env var.
       */
      defaultActionIfExceeded: BudgetEnforcementMode;
      /**
       * Company-wide default threshold percent (1–200). 100 = enforce on
       * overage, 80 = early warning at 80% utilization. Per-budget
       * `thresholdPercent` overrides this.
       */
      defaultThresholdPercent: number;
    };
  };
}

function parseEnforcementMode(raw: string | undefined): BudgetEnforcementMode {
  if (raw === 'stop' || raw === 'warn' || raw === 'ignore') return raw;
  return 'ignore';
}

const accounting: AccountingConfigSection['accounting'] = {
  enabled: process.env.ENABLE_ACCOUNTING !== 'false',
  fiscalYearStartMonth: parseInt(process.env.FISCAL_YEAR_START_MONTH || '7', 10),
  autoSeedAccounts: process.env.ACCOUNTING_AUTO_SEED !== 'false',
  extraTaxClasses: [],
  budget: {
    defaultActionIfExceeded: parseEnforcementMode(process.env.BUDGET_DEFAULT_ENFORCEMENT),
    defaultThresholdPercent: (() => {
      const n = parseInt(process.env.BUDGET_DEFAULT_THRESHOLD_PERCENT || '100', 10);
      return Number.isFinite(n) && n >= 1 && n <= 200 ? n : 100;
    })(),
  },
};

const accountingConfig: AccountingConfigSection = { accounting };

export default accountingConfig;
