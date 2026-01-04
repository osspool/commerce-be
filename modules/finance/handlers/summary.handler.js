import Transaction from '#modules/transaction/transaction.model.js';

function toBdt(paisa) {
  const n = Number(paisa || 0);
  return Math.round((n / 100) * 100) / 100;
}

function addTo(map, key, value) {
  map[key] = (map[key] || 0) + value;
}

export function buildFinanceSummary(rows) {
  const byKey = new Map();

  for (const row of rows || []) {
    const dateKey = row.dateKey;
    const branchCode = row.branchCode || 'N/A';
    const method = row.method || 'unknown';
    const flow = row.flow || 'inflow';
    const amountBdt = toBdt(row.amountPaisa);
    const count = Number(row.count || 0);

    const key = `${dateKey}__${branchCode}`;
    const existing = byKey.get(key) || {
      dateKey,
      branchCode,
      totals: {
        incomeBdt: 0,
        expenseBdt: 0,
        netBdt: 0,
        count: 0,
      },
      byMethod: {},
    };

    if (!existing.byMethod[method]) {
      existing.byMethod[method] = { incomeBdt: 0, expenseBdt: 0, netBdt: 0, count: 0 };
    }

    if (flow === 'outflow') {
      existing.totals.expenseBdt += amountBdt;
      existing.byMethod[method].expenseBdt += amountBdt;
    } else {
      existing.totals.incomeBdt += amountBdt;
      existing.byMethod[method].incomeBdt += amountBdt;
    }

    existing.totals.count += count;
    existing.byMethod[method].count += count;

    existing.totals.netBdt = Math.round((existing.totals.incomeBdt - existing.totals.expenseBdt) * 100) / 100;
    existing.byMethod[method].netBdt =
      Math.round((existing.byMethod[method].incomeBdt - existing.byMethod[method].expenseBdt) * 100) / 100;

    byKey.set(key, existing);
  }

  const summary = {
    totals: { incomeBdt: 0, expenseBdt: 0, netBdt: 0, count: 0 },
    byMethod: {},
    byDay: Array.from(byKey.values()).sort((a, b) => {
      if (a.dateKey === b.dateKey) return a.branchCode.localeCompare(b.branchCode);
      return a.dateKey.localeCompare(b.dateKey);
    }),
  };

  for (const item of summary.byDay) {
    summary.totals.incomeBdt += item.totals.incomeBdt;
    summary.totals.expenseBdt += item.totals.expenseBdt;
    summary.totals.count += item.totals.count;

    for (const [method, m] of Object.entries(item.byMethod)) {
      if (!summary.byMethod[method]) {
        summary.byMethod[method] = { incomeBdt: 0, expenseBdt: 0, netBdt: 0, count: 0 };
      }
      addTo(summary.byMethod[method], 'incomeBdt', m.incomeBdt);
      addTo(summary.byMethod[method], 'expenseBdt', m.expenseBdt);
      addTo(summary.byMethod[method], 'count', m.count);
      summary.byMethod[method].netBdt =
        Math.round((summary.byMethod[method].incomeBdt - summary.byMethod[method].expenseBdt) * 100) / 100;
    }
  }

  summary.totals.netBdt = Math.round((summary.totals.incomeBdt - summary.totals.expenseBdt) * 100) / 100;
  summary.totals.incomeBdt = Math.round(summary.totals.incomeBdt * 100) / 100;
  summary.totals.expenseBdt = Math.round(summary.totals.expenseBdt * 100) / 100;

  return summary;
}

/**
 * Finance summary (dashboard)
 *
 * Aggregates transaction totals by BD day and branch.
 * Useful for finance backoffice UI: totals + method breakdown (cash/bkash/nagad/card...).
 */
export async function getFinanceSummary(request, reply) {
  const {
    startDate,
    endDate,
    branchId,
    source,
    status,
  } = request.query || {};

  const match = {};
  if (source) match.source = source;
  if (status) match.status = status;
  if (branchId) match.branch = branchId;

  if (startDate || endDate) {
    match.date = {};
    if (startDate) match.date.$gte = new Date(startDate);
    if (endDate) match.date.$lte = new Date(endDate);
  }

  // Default: only finalized transactions for dashboards.
  if (!match.status) {
    match.status = { $in: ['verified', 'completed', 'refunded', 'partially_refunded'] };
  }

  const pipeline = [
    { $match: match },
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
      $addFields: {
        dateKey: {
          $dateToString: {
            format: '%Y-%m-%d',
            date: '$date',
            timezone: 'Asia/Dhaka',
          },
        },
      },
    },
    {
      $group: {
        _id: {
          dateKey: '$dateKey',
          branchCode: { $ifNull: ['$branch.code', 'N/A'] },
          method: '$method',
          flow: '$flow',
        },
        amountPaisa: { $sum: '$amount' },
        count: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        dateKey: '$_id.dateKey',
        branchCode: '$_id.branchCode',
        method: '$_id.method',
        flow: '$_id.flow',
        amountPaisa: 1,
        count: 1,
      },
    },
  ];

  const rows = await Transaction.aggregate(pipeline);
  const data = buildFinanceSummary(rows);
  return reply.send({ success: true, data });
}
