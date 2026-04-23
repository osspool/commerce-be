import type { FastifyRequest } from 'fastify';
import mongoose from 'mongoose';
import { Account, JournalEntry } from '../accounting.engine.js';

type Query = { from?: string; to?: string; branchId?: string };
type Req = FastifyRequest<{ Querystring: Query }> & { scope?: { organizationId?: string } };

function parseDateRange(q: Query): { from: Date; to: Date } {
  const now = new Date();
  const fy = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const from = q.from ? new Date(q.from) : new Date(Date.UTC(fy, 6, 1));
  const to = q.to ? new Date(q.to) : now;
  return { from, to };
}

function resolveOrgId(req: Req): string | undefined {
  return req.scope?.organizationId || req.query?.branchId;
}

async function accountIdsByPrefix(prefixes: string[]): Promise<mongoose.Types.ObjectId[]> {
  const rx = prefixes.map((p) => new RegExp(`^${p.replace(/\./g, '\\.')}`));
  const rows = await Account.find({ code: { $in: rx } })
    .select('_id code')
    .lean();
  return rows.map((r) => r._id as mongoose.Types.ObjectId);
}

async function aggregateByAccounts(
  orgId: string | undefined,
  from: Date,
  to: Date,
  accountIds: mongoose.Types.ObjectId[],
) {
  if (accountIds.length === 0) return [];
  const match: Record<string, unknown> = {
    state: 'posted',
    date: { $gte: from, $lte: to },
  };
  if (orgId) match.organizationId = new mongoose.Types.ObjectId(orgId);

  return JournalEntry.aggregate([
    { $match: match },
    { $unwind: '$journalItems' },
    { $match: { 'journalItems.account': { $in: accountIds } } },
    {
      $group: {
        _id: '$journalItems.account',
        debit: { $sum: '$journalItems.debit' },
        credit: { $sum: '$journalItems.credit' },
        count: { $sum: 1 },
      },
    },
    {
      $lookup: {
        from: Account.collection.collectionName,
        localField: '_id',
        foreignField: '_id',
        as: 'account',
      },
    },
    { $unwind: '$account' },
    {
      $project: {
        _id: 0,
        accountId: '$_id',
        accountCode: '$account.code',
        accountName: '$account.name',
        debit: 1,
        credit: 1,
        balance: { $subtract: ['$debit', '$credit'] },
        count: 1,
      },
    },
    { $sort: { accountCode: 1 } },
  ]);
}

export async function getAtReconciliation(req: Req) {
  const { from, to } = parseDateRange(req.query);
  const orgId = resolveOrgId(req);
  const accountIds = await accountIdsByPrefix(['1150', '1151', '1200']);
  const rows = await aggregateByAccounts(orgId, from, to, accountIds);
  const totals = rows.reduce((acc, r) => ({ debit: acc.debit + r.debit, credit: acc.credit + r.credit }), {
    debit: 0,
    credit: 0,
  });
  return {
    success: true,
    data: {
      period: { from, to },
      rows,
      totals: { ...totals, netClaimable: totals.debit - totals.credit },
    },
  };
}

export async function getVdsReceivable(req: Req) {
  const { from, to } = parseDateRange(req.query);
  const orgId = resolveOrgId(req);
  const accountIds = await accountIdsByPrefix(['1153']);
  const rows = await aggregateByAccounts(orgId, from, to, accountIds);
  const total = rows.reduce((a, r) => a + (r.debit - r.credit), 0);
  return { success: true, data: { period: { from, to }, rows, outstanding: total } };
}

export async function getVdsPayable(req: Req) {
  const { from, to } = parseDateRange(req.query);
  const orgId = resolveOrgId(req);
  const accountIds = await accountIdsByPrefix(['2136']);
  const rows = await aggregateByAccounts(orgId, from, to, accountIds);
  const total = rows.reduce((a, r) => a + (r.credit - r.debit), 0);
  return { success: true, data: { period: { from, to }, rows, payable: total } };
}

export async function getExportRefund(req: Req) {
  const { from, to } = parseDateRange(req.query);
  const orgId = resolveOrgId(req);
  const accountIds = await accountIdsByPrefix(['1150.VAT0.INPUT']);
  const rows = await aggregateByAccounts(orgId, from, to, accountIds);
  const claimable = rows.reduce((a, r) => a + (r.debit - r.credit), 0);
  return { success: true, data: { period: { from, to }, rows, claimable } };
}
