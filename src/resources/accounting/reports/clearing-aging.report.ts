/**
 * Clearing Account Aging Report
 *
 * For each clearing account (1125 Gateway / 1126 Mobile Money / 1127 COD),
 * lists posted debit lines (sales-side cash receipts on the clearing
 * account) that haven't been settled yet — i.e. no SettlementImport leg
 * has been linked to them.
 *
 * Buckets open lines by age (asOf - line.date):
 *   0-1d, 1-3d, 3-7d, 7-30d, 30+d
 *
 * The 30+d bucket is the operational alarm — money sitting in the
 * clearing account that long means a payout never arrived (provider
 * dispute, courier holding cash) and finance should escalate.
 *
 * Industry parity: this is the merchant-side equivalent of Stripe's
 * "Pending balance" / Xero's bank-rec aging.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import mongoose from 'mongoose';
import { JournalEntry } from '../accounting.engine.js';
import { resolveAccountId } from '../posting/posting.service.js';
import { BD } from '../posting/bd-account-codes.js';
import settlementImportRepository from '../settlement/settlement-import.repository.js';
import { ValidationError } from '@classytic/arc/utils';

type AgingReq = FastifyRequest<{
  Querystring: {
    clearingAccountCode?: string;
    asOf?: string;
    branchId?: string;
  };
}> & { scope?: { organizationId?: string } };

interface AgingBucket {
  label: string;
  count: number;
  amount: number;
}

interface OpenLine {
  journalEntryId: string;
  journalItemIndex: number;
  date: string;
  amount: number;
  ageDays: number;
  label?: string;
}

interface AgingReport {
  clearingAccountCode: string;
  asOf: string;
  totalOpen: number;
  totalLines: number;
  buckets: AgingBucket[];
  openLines: OpenLine[];
}

const BUCKET_DEFS: Array<{ label: string; min: number; max: number }> = [
  { label: '0-1d', min: 0, max: 1 },
  { label: '1-3d', min: 1, max: 3 },
  { label: '3-7d', min: 3, max: 7 },
  { label: '7-30d', min: 7, max: 30 },
  { label: '30+d', min: 30, max: Number.POSITIVE_INFINITY },
];

const DEFAULT_CLEARING_CODES = [BD.gatewayClearing, BD.mobileMoneyMerchant, BD.codClearing];

function bucketize(ageDays: number): string {
  for (const def of BUCKET_DEFS) {
    if (ageDays >= def.min && ageDays < def.max) return def.label;
  }
  return '30+d';
}

async function buildOneReport(
  organizationId: string,
  clearingAccountCode: string,
  asOf: Date,
): Promise<AgingReport> {
  const accountId = await resolveAccountId(clearingAccountCode);

  const orgObjectId = new mongoose.Types.ObjectId(organizationId);

  const entries = await JournalEntry.aggregate<{
    _id: mongoose.Types.ObjectId;
    date: Date;
    journalItems: Array<{
      account: mongoose.Types.ObjectId;
      debit: number;
      credit: number;
      label?: string;
      date?: Date;
    }>;
  }>([
    {
      $match: {
        organizationId: orgObjectId,
        state: 'posted',
        date: { $lte: asOf },
        'journalItems.account': accountId,
      },
    },
    { $project: { date: 1, journalItems: 1 } },
  ]);

  // Pre-fetch every persisted match for this org+clearing in one shot.
  const persistedMatches = await settlementImportRepository.aggregatePipeline<{
    _id: { entryId: string; itemIndex: number };
  }>([
    {
      $match: { organizationId: orgObjectId, clearingAccountCode },
    },
    { $unwind: '$legs' },
    { $match: { 'legs.matchedJournalItemIndex': { $ne: null } } },
    {
      $group: {
        _id: {
          entryId: { $toString: '$legs.matchedJournalEntryId' },
          itemIndex: '$legs.matchedJournalItemIndex',
        },
      },
    },
  ]);

  const settledKeys = new Set(persistedMatches.map((m) => `${m._id.entryId}:${m._id.itemIndex}`));

  const openLines: OpenLine[] = [];
  for (const entry of entries) {
    for (let i = 0; i < entry.journalItems.length; i++) {
      const item = entry.journalItems[i];
      if (String(item.account) !== String(accountId)) continue;
      if (item.debit <= 0) continue;
      const key = `${entry._id}:${i}`;
      if (settledKeys.has(key)) continue;

      const lineDate = item.date ?? entry.date;
      const ageMs = asOf.getTime() - new Date(lineDate).getTime();
      const ageDays = Math.max(0, Math.floor(ageMs / (24 * 60 * 60 * 1000)));

      openLines.push({
        journalEntryId: String(entry._id),
        journalItemIndex: i,
        date: new Date(lineDate).toISOString(),
        amount: item.debit,
        ageDays,
        label: item.label,
      });
    }
  }

  // Bucket aggregation
  const bucketAmounts: Record<string, AgingBucket> = {};
  for (const def of BUCKET_DEFS) {
    bucketAmounts[def.label] = { label: def.label, count: 0, amount: 0 };
  }

  let totalOpen = 0;
  for (const line of openLines) {
    const bucket = bucketAmounts[bucketize(line.ageDays)];
    bucket.count += 1;
    bucket.amount += line.amount;
    totalOpen += line.amount;
  }

  return {
    clearingAccountCode,
    asOf: asOf.toISOString(),
    totalOpen,
    totalLines: openLines.length,
    buckets: BUCKET_DEFS.map((d) => bucketAmounts[d.label]),
    openLines: openLines.sort((a, b) => b.ageDays - a.ageDays),
  };
}

export async function getClearingAging(req: AgingReq, reply: FastifyReply) {
  const orgId = req.scope?.organizationId ?? req.query?.branchId;
  if (!orgId) {
    throw new ValidationError('Organization context required.');
  }

  const asOf = req.query?.asOf ? new Date(req.query.asOf) : new Date();
  if (Number.isNaN(asOf.getTime())) {
    throw new ValidationError('Invalid asOf date.');
  }

  const codes = req.query?.clearingAccountCode
    ? [req.query.clearingAccountCode]
    : DEFAULT_CLEARING_CODES;

  const reports = await Promise.all(codes.map((c) => buildOneReport(orgId, c, asOf)));

  return reply.send({ asOf: asOf.toISOString(), reports });
}
