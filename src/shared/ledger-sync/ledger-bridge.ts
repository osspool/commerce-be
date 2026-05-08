/**
 * createLedgerBridge — adapter between @classytic/invoice's LedgerBridge
 * contract and @classytic/ledger's Record API.
 *
 * This is the glue layer that lets the invoice engine post journal entries,
 * record payments, and reverse entries through the ledger engine without
 * either package depending on the other.
 *
 * Lives in be-prod as host orchestration. Was extracted from
 * `@classytic/ledger/sync` in ledger 0.11.0 (PACKAGE_RULES P1: ledger
 * cannot import `@classytic/invoice` types). The whole file is self-
 * contained — zero runtime imports, every shape mirrored inline so it
 * works against any host invoice/ledger version that satisfies the
 * structural contract.
 *
 * @example
 * ```typescript
 * import { createAccountingEngine } from '@classytic/ledger';
 * import { createLedgerBridge } from '#shared/ledger-sync/ledger-bridge.js';
 * import { createInvoiceEngine } from '@classytic/invoice';
 *
 * const accounting = createAccountingEngine({ ... });
 *
 * const invoicing = createInvoiceEngine({
 *   ledger: createLedgerBridge(accounting, {
 *     accounts: {
 *       receivable: '1200',   // Accounts Receivable
 *       payable: '2000',      // Accounts Payable
 *       revenue: '4000',      // Revenue
 *       expense: '5000',      // Cost of Goods / Expenses
 *       taxPayable: '2100',   // Tax Payable (sales tax collected)
 *       taxReceivable: '1150', // Tax Receivable (purchase tax paid)
 *       cash: '1000',         // Cash / Bank
 *     },
 *   }),
 * });
 * ```
 *
 * The bridge maps each invoice moveType to the correct accounting entries:
 *
 *   out_invoice  → DR Receivable, CR Revenue per line, CR Tax Payable
 *   in_invoice   → DR Expense per line, DR Tax Receivable, CR Payable
 *   out_refund   → CR Receivable, DR Revenue per line, DR Tax Payable
 *   in_refund    → DR Payable, CR Expense per line, CR Tax Receivable
 *   receipt      → DR Cash/Receivable, CR Revenue per line, CR Tax Payable
 *
 * All amounts are integer cents. The bridge uses `record.adjustment()` for
 * multi-line entries (invoices with tax) and `record.payment()` for payment
 * recording.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

/** Account code mapping — tells the bridge which ledger accounts to use. */
export interface LedgerBridgeAccounts {
  /** Accounts Receivable (e.g. '1200'). Used for customer invoices + receipts. */
  receivable: string;
  /** Accounts Payable (e.g. '2000'). Used for vendor bills. */
  payable: string;
  /** Default revenue account (e.g. '4000'). Used for sales line items. */
  revenue: string;
  /** Default expense account (e.g. '5000'). Used for purchase line items. */
  expense: string;
  /** Tax payable / tax liability (e.g. '2100'). Sales tax collected. */
  taxPayable: string;
  /** Tax receivable / input tax (e.g. '1150'). Purchase tax paid. */
  taxReceivable: string;
  /** Cash / bank account (e.g. '1000'). Used for payments. */
  cash: string;
}

export interface LedgerBridgeConfig {
  /** Account code mapping. */
  accounts: LedgerBridgeAccounts;
  /**
   * Override the debit account for receipts (POS).
   * Defaults to `accounts.receivable`. Set to `accounts.cash` if receipts
   * are immediately paid (no AR).
   */
  receiptAccount?: string;
  /**
   * Custom resolver for payment accounts. When provided, the bridge calls
   * this instead of using the default receivable/cash mapping.
   *
   * Use this when the invoice engine doesn't track moveType on payments
   * and you need to determine AR vs AP based on context.
   */
  resolvePaymentAccounts?: (input: LedgerPaymentInput) => {
    receivableOrPayable: string;
    cash: string;
  };
}

// ─── Invoice-side types (mirrored from @classytic/invoice) ─────────────────
// These are defined here so the ledger doesn't depend on the invoice package.

type MoveType = 'out_invoice' | 'in_invoice' | 'out_refund' | 'in_refund' | 'receipt';

export interface LedgerPostInput {
  organizationId?: string;
  invoiceId: string;
  moveType: MoveType;
  partnerId: string;
  date: Date;
  currency: string;
  lines: LedgerPostLine[];
  totalAmount: number;
  taxAmount: number;
  notes?: string;
  idempotencyKey?: string;
}

export interface LedgerPostLine {
  description: string;
  amount: number;
  taxAmount: number;
  taxCode?: string;
  productId?: string;
}

export interface LedgerPaymentInput {
  organizationId?: string;
  invoiceId: string;
  paymentId: string;
  amount: number;
  currency: string;
  date: Date;
  method: string;
}

/**
 * The LedgerBridge interface that @classytic/invoice expects.
 * This is the contract — createLedgerBridge() returns an implementation.
 */
export interface LedgerBridge {
  createJournalEntry(input: LedgerPostInput): Promise<string>;
  reverseJournalEntry(
    journalEntryId: string,
    reason: string,
    ctx: LedgerReverseContext,
  ): Promise<string>;
  recordPayment(input: LedgerPaymentInput): Promise<string>;
}

/**
 * Context threaded from the invoice engine into the ledger reversal call.
 * Required so the ledger can stamp `reversedByUser` and satisfy strict-mode
 * `requireActor` / multi-tenant guards.
 */
export interface LedgerReverseContext {
  organizationId?: string;
  actorId?: string;
  session?: unknown;
}

// ─── Engine shape (minimal interface — no hard dep on AccountingEngine) ────

interface AdjustmentLine {
  account: string;
  debit?: number;
  credit?: number;
  label?: string;
}

interface RecordAPILike {
  adjustment(
    organizationId: unknown,
    input: { date: Date; lines: AdjustmentLine[]; label?: string; journalType?: string },
    options?: { idempotencyKey?: string; [key: string]: unknown },
  ): Promise<unknown>;
  payment(
    organizationId: unknown,
    input: {
      date: Date;
      amount: number;
      fromReceivableAccount: string;
      toCashAccount: string;
      label?: string;
    },
    options?: { idempotencyKey?: string; [key: string]: unknown },
  ): Promise<unknown>;
}

interface JournalEntryRepoLike {
  reverse(
    id: unknown,
    orgId?: unknown,
    options?: { actorId?: string; session?: unknown; reversalDate?: Date },
  ): Promise<{ original: { _id: unknown }; reversal: { _id: unknown } }>;
}

interface EngineLike {
  record: RecordAPILike;
  repositories: { journalEntries: JournalEntryRepoLike };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const isCustomerSide = (t: MoveType): boolean =>
  t === 'out_invoice' || t === 'out_refund' || t === 'receipt';

const isRefund = (t: MoveType): boolean => t === 'out_refund' || t === 'in_refund';

const JOURNAL_TYPE_MAP: Record<MoveType, string> = {
  out_invoice: 'SALES',
  in_invoice: 'PURCHASES',
  out_refund: 'SALES',
  in_refund: 'PURCHASES',
  receipt: 'CASH_RECEIPTS',
};

// ─── Factory ───────────────────────────────────────────────────────────────

/**
 * Create a LedgerBridge implementation backed by a @classytic/ledger engine.
 *
 * @param engine - The accounting engine (or any object matching the minimal
 *   shape: `{ record: { adjustment, payment }, repositories: { journalEntries: { reverse } } }`)
 * @param config - Account mapping configuration
 * @returns A LedgerBridge that the invoice engine can use
 */
export function createLedgerBridge(engine: EngineLike, config: LedgerBridgeConfig): LedgerBridge {
  const { accounts } = config;

  return {
    async createJournalEntry(input: LedgerPostInput): Promise<string> {
      const customerSide = isCustomerSide(input.moveType);
      const refund = isRefund(input.moveType);
      const isReceipt = input.moveType === 'receipt';

      // Determine accounts based on moveType
      const balanceSheetAccount = customerSide
        ? isReceipt && config.receiptAccount
          ? config.receiptAccount
          : accounts.receivable
        : accounts.payable;
      const incomeOrExpenseAccount = customerSide ? accounts.revenue : accounts.expense;
      const taxAccount = customerSide ? accounts.taxPayable : accounts.taxReceivable;

      // Build journal lines
      const lines: AdjustmentLine[] = [];

      if (customerSide && !refund) {
        // ── Customer Invoice / Receipt ──
        // DR Receivable (or Cash for receipt) for total
        lines.push({
          account: balanceSheetAccount,
          debit: input.totalAmount,
          label: `Invoice ${input.invoiceId}`,
        });
        // CR Revenue per line
        for (const line of input.lines) {
          lines.push({
            account: incomeOrExpenseAccount,
            credit: line.amount,
            label: line.description,
          });
        }
        // CR Tax Payable (if any)
        if (input.taxAmount > 0) {
          lines.push({
            account: taxAccount,
            credit: input.taxAmount,
            label: 'Tax',
          });
        }
      } else if (customerSide && refund) {
        // ── Customer Credit Note (out_refund) — reversed ──
        // CR Receivable
        lines.push({
          account: balanceSheetAccount,
          credit: input.totalAmount,
          label: `Credit Note ${input.invoiceId}`,
        });
        // DR Revenue per line
        for (const line of input.lines) {
          lines.push({
            account: incomeOrExpenseAccount,
            debit: line.amount,
            label: line.description,
          });
        }
        // DR Tax Payable
        if (input.taxAmount > 0) {
          lines.push({
            account: taxAccount,
            debit: input.taxAmount,
            label: 'Tax reversal',
          });
        }
      } else if (!customerSide && !refund) {
        // ── Vendor Bill (in_invoice) ──
        // DR Expense per line
        for (const line of input.lines) {
          lines.push({
            account: incomeOrExpenseAccount,
            debit: line.amount,
            label: line.description,
          });
        }
        // DR Tax Receivable (if any)
        if (input.taxAmount > 0) {
          lines.push({
            account: taxAccount,
            debit: input.taxAmount,
            label: 'Tax',
          });
        }
        // CR Payable for total
        lines.push({
          account: balanceSheetAccount,
          credit: input.totalAmount,
          label: `Bill ${input.invoiceId}`,
        });
      } else {
        // ── Vendor Credit Note (in_refund) — reversed ──
        // DR Payable
        lines.push({
          account: balanceSheetAccount,
          debit: input.totalAmount,
          label: `Vendor Credit ${input.invoiceId}`,
        });
        // CR Expense per line
        for (const line of input.lines) {
          lines.push({
            account: incomeOrExpenseAccount,
            credit: line.amount,
            label: line.description,
          });
        }
        // CR Tax Receivable
        if (input.taxAmount > 0) {
          lines.push({
            account: taxAccount,
            credit: input.taxAmount,
            label: 'Tax reversal',
          });
        }
      }

      const label = input.notes
        ? `${input.moveType} ${input.invoiceId} — ${input.notes}`
        : `${input.moveType} ${input.invoiceId}`;

      const result = (await engine.record.adjustment(
        input.organizationId,
        {
          date: input.date,
          lines,
          label,
          journalType: JOURNAL_TYPE_MAP[input.moveType] ?? 'GENERAL',
        },
        input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {},
      )) as { _id: unknown };

      return String(result._id);
    },

    async reverseJournalEntry(
      journalEntryId: string,
      _reason: string,
      ctx: LedgerReverseContext,
    ): Promise<string> {
      const options: { actorId?: string; session?: unknown } = {};
      if (ctx.actorId) options.actorId = ctx.actorId;
      if (ctx.session) options.session = ctx.session;
      const result = await engine.repositories.journalEntries.reverse(
        journalEntryId,
        ctx.organizationId,
        options,
      );
      return String(result.reversal._id);
    },

    async recordPayment(input: LedgerPaymentInput): Promise<string> {
      let fromAccount: string;
      let toAccount: string;

      if (config.resolvePaymentAccounts) {
        const resolved = config.resolvePaymentAccounts(input);
        fromAccount = resolved.receivableOrPayable;
        toAccount = resolved.cash;
      } else {
        fromAccount = accounts.receivable;
        toAccount = accounts.cash;
      }

      const result = (await engine.record.payment(
        input.organizationId,
        {
          date: input.date,
          amount: input.amount,
          fromReceivableAccount: fromAccount,
          toCashAccount: toAccount,
          label: `Payment ${input.paymentId} for ${input.invoiceId}`,
        },
        { idempotencyKey: `payment:${input.paymentId}` },
      )) as { _id: unknown };

      return String(result._id);
    },
  };
}
