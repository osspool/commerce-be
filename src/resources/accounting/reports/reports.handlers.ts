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
import { decorateNestedPartnerNames } from '../_shared/partner-resolver.service.js';
import {
  type BudgetRow,
  enrichBudgetVsActual,
  type GLAccount,
  parseDateParams,
  projectGeneralLedger,
  type ReportQuery,
  toObjectId,
} from './reports.utils.js';
import { ValidationError } from '@classytic/arc/utils';

type Req = FastifyRequest<{ Querystring: ReportQuery }> & {
  scope?: { organizationId?: string };
};

type ScopedReq = FastifyRequest & {
  scope?: { organizationId?: string };
  query?: { branchId?: string };
};

/** orgId resolution: branch scope wins, ?branchId fallback for superadmin.
 *
 * On `raw: true` report routes, arc's BA-adapter scope-set hook may not run
 * before the handler — `req.scope.organizationId` ends up undefined and reports
 * silently aggregate across all branches. Falling back to the `x-organization-id`
 * header matches the JE-list adapter's behavior and restores branch isolation.
 *
 * Returns `undefined` when no source produces an id; only call this when the
 * caller can tolerate an empty scope (it should be rare). Reports that touch
 * org-scoped data MUST use `requireOrgId` instead.
 */
function resolveOrgId(req: ScopedReq): string | undefined {
  const fromScope = req.scope?.organizationId;
  if (fromScope) return fromScope;
  const fromQuery = (req.query as { branchId?: string } | undefined)?.branchId;
  if (fromQuery) return fromQuery;
  const fromHeader = req.headers['x-organization-id'];
  if (typeof fromHeader === 'string' && fromHeader) return fromHeader;
  return undefined;
}

/**
 * Strict variant — throws ValidationError when no orgId can be resolved.
 *
 * Every financial report touches org-scoped JE data; if we let an undefined
 * orgId through, the underlying ledger aggregation drops the org filter and
 * silently returns ALL-branches numbers. That has shipped wrong P&Ls before
 * and is the highest-blast-radius bug class in the report layer. Use this
 * everywhere except when the caller has already proven org context.
 */
export function requireOrgId(req: ScopedReq): string {
  const id = resolveOrgId(req);
  if (!id) {
    throw new ValidationError(
      'organizationId is required — pass via x-organization-id header or ?branchId. Reports must always be branch-scoped to prevent cross-branch leakage.',
    );
  }
  return id;
}

/** Build the common params object passed to every ledger report.
 *
 * Branch scoping (single-company-multi-branch deployments):
 *
 * The accounting engine uses `journalEntryOrgField: 'organizationId'` (tag
 * mode), NOT `multiTenant.tenantField` (scope mode). In tag mode the ledger
 * stamps the field on JE docs but does NOT auto-filter reports — that's the
 * host's job. We pass the branch as a `filters: { organizationId: ... }`
 * dimension so the ledger appends it into the report's $match stage. Without
 * this, every report aggregates across all branches and breaks branch isolation.
 */
function buildReportParams(req: Req, extra: Record<string, unknown> = {}) {
  const orgId = requireOrgId(req);
  const orgObjectId = toObjectId(orgId);
  const { dateOption, dateValue } = parseDateParams(req.query);
  return {
    organizationId: orgObjectId,
    filters: { organizationId: orgObjectId },
    dateOption,
    dateValue,
    ...(req.query.comparative ? { comparative: req.query.comparative } : {}),
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
    return result;
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
    accounts: projectGeneralLedger(result.accounts as GLAccount[]),
    period: result.period,
  };
}

// ─── A/P and A/R subsidiary-ledger reports (ledger 0.7) ────────────────────

const BUCKETS = [
  { label: 'Current', minDays: 0, maxDays: 31 },
  { label: '31-60', minDays: 31, maxDays: 61 },
  { label: '61-90', minDays: 61, maxDays: 91 },
  { label: '90+', minDays: 91, maxDays: Infinity },
];

type AgingReq = FastifyRequest<{ Querystring: { asOfDate?: string; accountCode?: string; branchId?: string } }> & {
  scope?: { organizationId?: string };
};

async function resolveAccountIdByCode(code: string) {
  const acc = await Account.findOne({ accountTypeCode: code }).select('_id').lean();
  if (!acc) throw new Error(`Account ${code} not found — run /accounting/accounts/seed`);
  return acc._id as mongoose.Types.ObjectId;
}

function agingHandler(type: 'payable' | 'receivable', defaultCode: string) {
  return async (req: AgingReq) => {
    // Branch-scope FIRST. Without orgId the ledger aggregates across every
    // branch's payables/receivables and the report ships wrong numbers.
    const orgId = requireOrgId(req);
    // YYYY-MM-DD strings parse to start-of-day UTC; promote to end-of-day so
    // entries posted any time on `asOfDate` are included.
    const raw = req.query.asOfDate;
    const asOfDate = raw
      ? /^\d{4}-\d{2}-\d{2}$/.test(raw)
        ? new Date(`${raw}T23:59:59.999Z`)
        : new Date(raw)
      : new Date();
    const code = req.query.accountCode || defaultCode;
    const accountId = await resolveAccountIdByCode(code);
    const result = await accounting.reports.agedBalance({
      organizationId: toObjectId(orgId),
      asOfDate,
      type,
      accountIds: [accountId],
      contactField: 'journalItems.partnerId',
      dueDateField: 'journalItems.maturityDate',
      buckets: BUCKETS,
    });
    // Kernel returns raw `contactId` (= partnerId from the JE item). Decorate
    // each row with `partnerName` joined from Customer/Supplier so the UI
    // doesn't render bare ObjectIds. The default side maps the report type:
    // `receivable` → customer, `payable` → supplier.
    const partnerSide = type === 'receivable' ? 'customer' : 'supplier';
    const decoratedRows = await decorateNestedPartnerNames(
      result.rows,
      (r) => (r.contactId as string | undefined) ?? null,
      () => partnerSide,
      partnerSide,
    );
    return { ...result, rows: decoratedRows };
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
    branchId?: string;
  };
}> & { scope?: { organizationId?: string } };

export async function getPartnerLedger(req: PartnerLedgerReq, reply: FastifyReply) {
  const { partnerId, controlAccountCode, startDate, endDate } = req.query;
  if (!partnerId || !startDate || !endDate) {
    throw new ValidationError('partnerId, startDate, and endDate are required');
  }
  // Without org scope the partner ledger pulls JEs from every branch — a
  // partner's history would conflate Dhaka HO and Uttara store balances and
  // the running balance would be meaningless. Always fail closed.
  const orgId = requireOrgId(req);
  const code = controlAccountCode || '2111';
  const controlAccountId = await resolveAccountIdByCode(code);
  const result = await generatePartnerLedger(
    {
      AccountModel: Account as never,
      JournalEntryModel: JournalEntry as never,
    } as never,
    {
      organizationId: toObjectId(orgId),
      controlAccountId,
      partnerId,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      includeMatched: true,
      buckets: BUCKETS,
    } as never,
  );
  return result;
}

export async function getBudgetVsActual(req: Req, reply: FastifyReply) {
  // biome-ignore lint/suspicious/noExplicitAny: optional method on engine
  const reports = accounting.reports as any;
  if (!reports.budgetVsActual) {
    throw new ValidationError('Budget reports not available in this mode');
  }

  const params = buildReportParams(req, { accountIds: req.query.accountIds });
  const baseReport = await reports.budgetVsActual(params);

  const periodStart = new Date(baseReport.metadata.periodStart);
  const periodEnd = new Date(baseReport.metadata.periodEnd);
  const enriched = enrichBudgetVsActual(baseReport.rows as BudgetRow[], periodStart, periodEnd);

  return {
    ...baseReport,
    rows: enriched.rows,
    summary: {
      ...baseReport.summary,
      totalTheoreticalAmount: enriched.totalTheoreticalAmount,
      avgBurnRate: enriched.avgBurnRate,
    },
  };
}

// ─── Daybook (Detailed General Journal / Journal Listing) ──────────────────

type DaybookReq = FastifyRequest<{
  Querystring: {
    startDate?: string;
    endDate?: string;
    state?: 'posted' | 'draft' | 'all';
    accountId?: string;
    journalType?: string;
    partnerId?: string;
    limit?: string;
    branchId?: string;
  };
}> & { scope?: { organizationId?: string } };

export async function getDaybook(req: DaybookReq, reply: FastifyReply) {
  const { startDate, endDate, state, accountId, journalType, partnerId, limit } = req.query;
  if (!startDate || !endDate) {
    throw new ValidationError('startDate and endDate are required (YYYY-MM-DD)');
  }
  // Daybook lists every JE in the period — without org scope a sub-branch
  // user could see HO entries (and vice versa). Strict scope.
  const orgId = requireOrgId(req);
  // Promote bare YYYY-MM-DD to end-of-day on the inclusive boundary so an
  // entry posted at 14:00 on `endDate` is still in scope.
  const start = /^\d{4}-\d{2}-\d{2}$/.test(startDate)
    ? new Date(`${startDate}T00:00:00.000Z`)
    : new Date(startDate);
  const end = /^\d{4}-\d{2}-\d{2}$/.test(endDate)
    ? new Date(`${endDate}T23:59:59.999Z`)
    : new Date(endDate);

  // biome-ignore lint/suspicious/noExplicitAny: ledger reports surface as a loose record
  const fn = (accounting.reports as any).daybook;
  if (!fn) {
    throw new ValidationError('Daybook report not available in this mode');
  }
  const result = await fn({
    organizationId: toObjectId(orgId),
    startDate: start,
    endDate: end,
    state,
    ...(accountId ? { accountId: toObjectId(accountId) } : {}),
    ...(journalType ? { journalType } : {}),
    ...(partnerId ? { partnerId } : {}),
    ...(limit ? { limit: Number(limit) } : {}),
  });
  return result;
}
