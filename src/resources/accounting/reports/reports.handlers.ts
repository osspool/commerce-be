/**
 * Financial Report Handlers
 *
 * Thin Fastify handlers that delegate to the @classytic/ledger engine.
 * All math/parsing lives in reports.utils.ts and is unit-tested separately.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { accounting } from '../accounting.engine.js';
import {
  parseDateParams,
  toObjectId,
  enrichBudgetVsActual,
  projectGeneralLedger,
  type ReportQuery,
  type GLAccount,
  type BudgetRow,
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

export async function getBudgetVsActual(req: Req, reply: FastifyReply) {
  // biome-ignore lint/suspicious/noExplicitAny: optional method on engine
  const reports = accounting.reports as any;
  if (!reports.budgetVsActual) {
    return reply
      .status(400)
      .send({ success: false, message: 'Budget reports not available in this mode' });
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
