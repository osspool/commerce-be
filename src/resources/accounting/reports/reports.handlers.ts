/**
 * Financial Report Handlers
 *
 * Thin Fastify handlers that delegate to the @classytic/ledger engine.
 * All math/parsing lives in reports.utils.ts and is unit-tested separately.
 */

import { generatePartnerLedger } from '@classytic/ledger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type mongoose from 'mongoose';
import { Account, accounting, JournalEntry } from '../accounting.engine.js';
import {
  type BudgetRow,
  enrichBudgetVsActual,
  type GLAccount,
  parseDateParams,
  projectGeneralLedger,
  type ReportQuery,
  toObjectId,
} from './reports.utils.js';

type Req = FastifyRequest<{ Querystring: ReportQuery }> & {
  scope?: { organizationId?: string };
};

/** orgId resolution: branch scope wins, ?branchId fallback for superadmin. */
function resolveOrgId(req: Req): string | undefined {
  return req.scope?.organizationId || req.query?.branchId;
}

/** Build the common params object passed to every ledger report. */
function buildReportParams(req: Req, extra: Record<string, unknown> = {}) {
  const orgId = resolveOrgId(req);
  const { dateOption, dateValue } = parseDateParams(req.query);
  return {
    ...(orgId ? { organizationId: toObjectId(orgId) } : {}),
    dateOption,
    dateValue,
    ...extra,
  };
}

/** Generic factory for reports that just forward params + return result as-is. */
function makeReportHandler(
  reportFn: keyof typeof accounting.reports,
  extraParams?: (query: ReportQuery) => Record<string, unknown>,
) {
  return async (req: Req) => {
    const params = buildReportParams(req, extraParams ? extraParams(req.query) : {});
    // biome-ignore lint/suspicious/noExplicitAny: ledger reports surface as a loose record
    const fn = (accounting.reports as any)[reportFn];
    const result = await fn(params);
    return { success: true, data: result };
  };
}

export const getTrialBalance = makeReportHandler('trialBalance', (q) => ({
  accountId: q.accountId,
}));

export const getBalanceSheet = makeReportHandler('balanceSheet');

export const getIncomeStatement = makeReportHandler('incomeStatement');

export const getCashFlow = makeReportHandler('cashFlow');

export async function getGeneralLedger(req: Req) {
  const params = buildReportParams(req, { accountId: req.query.accountId });
  // biome-ignore lint/suspicious/noExplicitAny: ledger result type is loose
  const result: any = await accounting.reports.generalLedger(params);
  return {
    success: true,
    data: {
      accounts: projectGeneralLedger(result.accounts as GLAccount[]),
      period: result.period,
    },
  };
}

// ─── A/P and A/R subsidiary-ledger reports (ledger 0.7) ────────────────────

const BUCKETS = [
  { label: 'Current', minDays: 0, maxDays: 31 },
  { label: '31-60', minDays: 31, maxDays: 61 },
  { label: '61-90', minDays: 61, maxDays: 91 },
  { label: '90+', minDays: 91, maxDays: Infinity },
];

type AgingReq = FastifyRequest<{ Querystring: { asOfDate?: string; accountCode?: string } }>;

async function resolveAccountIdByCode(code: string) {
  const acc = await Account.findOne({ accountTypeCode: code }).select('_id').lean();
  if (!acc) throw new Error(`Account ${code} not found — run /accounting/accounts/seed`);
  return acc._id as mongoose.Types.ObjectId;
}

function agingHandler(type: 'payable' | 'receivable', defaultCode: string) {
  return async (req: AgingReq) => {
    const asOfDate = req.query.asOfDate ? new Date(req.query.asOfDate) : new Date();
    const code = req.query.accountCode || defaultCode;
    const accountId = await resolveAccountIdByCode(code);
    const result = await accounting.reports.agedBalance({
      asOfDate,
      type,
      accountIds: [accountId],
      contactField: 'journalItems.partnerId',
      dueDateField: 'journalItems.maturityDate',
      buckets: BUCKETS,
    });
    return { success: true, data: result };
  };
}

export const getApAging = agingHandler('payable', '2111');
export const getArAging = agingHandler('receivable', '1141');

type PartnerLedgerReq = FastifyRequest<{
  Querystring: {
    partnerId: string;
    controlAccountCode?: string;
    startDate: string;
    endDate: string;
  };
}>;

export async function getPartnerLedger(req: PartnerLedgerReq, reply: FastifyReply) {
  const { partnerId, controlAccountCode, startDate, endDate } = req.query;
  if (!partnerId || !startDate || !endDate) {
    return reply.status(400).send({
      success: false,
      message: 'partnerId, startDate, and endDate are required',
    });
  }
  const code = controlAccountCode || '2111';
  const controlAccountId = await resolveAccountIdByCode(code);
  const result = await generatePartnerLedger(
    {
      AccountModel: Account as never,
      JournalEntryModel: JournalEntry as never,
    } as never,
    {
      controlAccountId,
      partnerId,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      includeMatched: true,
      buckets: BUCKETS,
    } as never,
  );
  return { success: true, data: result };
}

export async function getBudgetVsActual(req: Req, reply: FastifyReply) {
  // biome-ignore lint/suspicious/noExplicitAny: optional method on engine
  const reports = accounting.reports as any;
  if (!reports.budgetVsActual) {
    return reply.status(400).send({ success: false, message: 'Budget reports not available in this mode' });
  }

  const params = buildReportParams(req, { accountIds: req.query.accountIds });
  const baseReport = await reports.budgetVsActual(params);

  const periodStart = new Date(baseReport.metadata.periodStart);
  const periodEnd = new Date(baseReport.metadata.periodEnd);
  const enriched = enrichBudgetVsActual(baseReport.rows as BudgetRow[], periodStart, periodEnd);

  return {
    success: true,
    data: {
      ...baseReport,
      rows: enriched.rows,
      summary: {
        ...baseReport.summary,
        totalTheoreticalAmount: enriched.totalTheoreticalAmount,
        avgBurnRate: enriched.avgBurnRate,
      },
    },
  };
}
