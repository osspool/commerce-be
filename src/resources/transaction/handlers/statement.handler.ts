import { stringify as csvStringify } from 'csv-stringify/sync';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getTransactionModel } from '#shared/revenue/engine.js';

interface AggregatedDoc {
  _id: unknown;
  amount: number;
  net: number;
  currency: string;
  flow: string;
  type: string;
  status: string;
  method: string;
  source: string;
  sourceModel: string;
  sourceId: unknown;
  date: Date;
  createdAt: Date;
  metadata: Record<string, unknown>;
  paymentDetails: Record<string, unknown>;
  branch: { _id: unknown; code: string } | null;
  order: { _id: unknown; customerName: string; vat: Record<string, unknown> } | null;
}

interface StatementRow {
  transactionId: string;
  transactionDate: string | null;
  createdAt: string | null;
  status: string;
  flow: string;
  type: string;
  source: string;
  branchCode: string | null;
  branchId: string | null;
  method: string;
  amountBdt: number;
  netBdt: number;
  currency: string;
  sourceModel: string;
  sourceId: string | null;
  orderId: string | null;
  orderCustomerName: string | null;
  vatInvoiceNumber: string | null;
  vatSellerBin: string | null;
  paymentReference: string | null;
  narration: string | null;
}

function toBdt(amountInPaisa: number | null | undefined): number {
  const n = Number(amountInPaisa || 0);
  return Math.round((n / 100) * 100) / 100;
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  const d = new Date(value as string | number | Date);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function formatStatementRows(docs: AggregatedDoc[]): StatementRow[] {
  return (docs || []).map((d) => ({
    transactionId: String(d._id),
    transactionDate: toIso(d.date) || toIso(d.createdAt),
    createdAt: toIso(d.createdAt),
    status: d.status,
    flow: d.flow,
    type: d.type,
    source: d.source,
    branchCode: d.branch?.code || null,
    branchId: d.branch?._id ? String(d.branch._id) : null,
    method: d.method,
    amountBdt: toBdt(d.amount),
    netBdt: toBdt(d.net),
    currency: d.currency || 'BDT',
    sourceModel: d.sourceModel,
    sourceId: d.sourceId ? String(d.sourceId) : null,
    orderId: d.order?._id ? String(d.order._id) : null,
    orderCustomerName: d.order?.customerName || null,
    vatInvoiceNumber:
      ((d.order?.vat as Record<string, unknown>)?.invoiceNumber as string) ||
      ((d.metadata as Record<string, unknown>)?.vatInvoiceNumber as string) ||
      null,
    vatSellerBin:
      ((d.order?.vat as Record<string, unknown>)?.sellerBin as string) ||
      ((d.metadata as Record<string, unknown>)?.vatSellerBin as string) ||
      null,
    paymentReference:
      ((d.metadata as Record<string, unknown>)?.paymentReference as string) ||
      ((d.metadata as Record<string, unknown>)?.senderPhone as string) ||
      ((d.paymentDetails as Record<string, unknown>)?.trxId as string) ||
      null,
    narration: ((d.metadata as Record<string, unknown>)?.narration as string) || null,
  }));
}

interface StatementQuery {
  startDate?: string;
  endDate?: string;
  branchId?: string;
  source?: string;
  status?: string;
  format?: string;
}

/**
 * Finance statement export (CSV/JSON)
 */
export async function getStatement(
  request: FastifyRequest<{ Querystring: StatementQuery }>,
  reply: FastifyReply,
): Promise<void> {
  const { startDate, endDate, branchId, source, status, format = 'csv' } = request.query || {};

  const match: Record<string, unknown> = {};
  if (source) match.source = source;
  if (status) match.status = status;
  if (branchId) match.branch = branchId;

  if (startDate || endDate) {
    const dateFilter: Record<string, Date> = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) dateFilter.$lte = new Date(endDate);
    match.date = dateFilter;
  }

  const pipeline: any[] = [
    { $match: match },
    { $sort: { date: -1, _id: -1 } },
    { $limit: 50000 },
    {
      $lookup: {
        from: 'branches',
        localField: 'branch',
        foreignField: '_id',
        as: 'branch',
      },
    },
    { $unwind: { path: '$branch', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'orders',
        let: { refId: '$sourceId', refModel: '$sourceModel' },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ['$$refModel', 'Order'] }, { $eq: ['$_id', '$$refId'] }] } } },
          { $project: { customerName: 1, vat: 1 } },
        ],
        as: 'order',
      },
    },
    { $unwind: { path: '$order', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        amount: 1,
        net: 1,
        currency: 1,
        flow: 1,
        type: 1,
        status: 1,
        method: 1,
        source: 1,
        sourceModel: 1,
        sourceId: 1,
        date: 1,
        createdAt: 1,
        metadata: 1,
        paymentDetails: 1,
        branch: { _id: 1, code: 1 },
        order: 1,
      },
    },
  ];

  const docs = await getTransactionModel().aggregate(pipeline);
  const rows = formatStatementRows(docs as AggregatedDoc[]);

  if (format === 'json') {
    return reply.send({ success: true, count: rows.length, data: rows });
  }

  const csv = csvStringify(rows, { header: true });
  reply.header('Content-Type', 'text/csv');
  reply.header('Content-Disposition', 'attachment; filename="transactions-statement.csv"');
  return reply.send(csv);
}
