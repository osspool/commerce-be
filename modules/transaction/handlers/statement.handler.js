import Transaction from '../transaction.model.js';
import { stringify as csvStringify } from 'csv-stringify/sync';

function toBdt(amountInPaisa) {
  const n = Number(amountInPaisa || 0);
  return Math.round((n / 100) * 100) / 100;
}

function toIso(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function formatStatementRows(docs) {
  return (docs || []).map(d => ({
    transactionId: String(d._id),
    transactionDate: toIso(d.transactionDate) || toIso(d.createdAt),
    createdAt: toIso(d.createdAt),
    status: d.status,
    type: d.type,
    source: d.source,
    branchCode: d.branch?.code || null,
    branchId: d.branch?._id ? String(d.branch._id) : (d.branchId ? String(d.branchId) : null),
    method: d.method,
    amountBdt: toBdt(d.amount),
    currency: d.currency || 'BDT',
    referenceModel: d.referenceModel,
    referenceId: d.referenceId ? String(d.referenceId) : null,
    orderId: d.order?._id ? String(d.order._id) : null,
    orderCustomerName: d.order?.customerName || null,
    vatInvoiceNumber: d.order?.vat?.invoiceNumber || d.metadata?.vatInvoiceNumber || null,
    vatSellerBin: d.order?.vat?.sellerBin || d.metadata?.vatSellerBin || null,
    paymentReference: d.metadata?.paymentReference || d.metadata?.senderPhone || d.paymentDetails?.trxId || null,
    narration: d.metadata?.narration || null,
  }));
}

/**
 * Finance statement export (CSV/JSON)
 *
 * Goal: a clean, accountant-friendly export that can be mapped into tools like Excel,
 * Tally/ERP imports, or manual journal entry workflows.
 *
 * Notes:
 * - This is a transaction log / statement, not a full double-entry ledger.
 * - For double-entry accounting exports, we'd add a COA + posting rules layer.
 */
export async function getStatement(request, reply) {
  const {
    startDate,
    endDate,
    branchId,
    source,
    status,
    format = 'csv',
  } = request.query || {};

  const match = {};
  if (source) match.source = source;
  if (status) match.status = status;
  if (branchId) match.branch = branchId;

  if (startDate || endDate) {
    match.transactionDate = {};
    if (startDate) match.transactionDate.$gte = new Date(startDate);
    if (endDate) match.transactionDate.$lte = new Date(endDate);
  }

  const pipeline = [
    { $match: match },
    { $sort: { transactionDate: -1, _id: -1 } },
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
        let: { refId: '$referenceId', refModel: '$referenceModel' },
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
        currency: 1,
        type: 1,
        status: 1,
        method: 1,
        source: 1,
        referenceModel: 1,
        referenceId: 1,
        transactionDate: 1,
        createdAt: 1,
        metadata: 1,
        paymentDetails: 1,
        branch: { _id: 1, code: 1 },
        order: 1,
      },
    },
  ];

  const docs = await Transaction.aggregate(pipeline);
  const rows = formatStatementRows(docs);

  if (format === 'json') {
    return reply.send({ success: true, count: rows.length, data: rows });
  }

  const csv = csvStringify(rows, { header: true });
  reply.header('Content-Type', 'text/csv');
  reply.header('Content-Disposition', 'attachment; filename="transactions-statement.csv"');
  return reply.send(csv);
}

