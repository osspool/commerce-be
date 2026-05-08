/**
 * Musok Invoice Repository — extends mongokit Repository
 *
 * Domain methods on top of standard CRUD (getAll, getById, create, update, delete).
 * No wrappers, no aliases — mongokit naming.
 */

import { formatMusokSerial } from '@classytic/bd-tax';
import { Repository } from '@classytic/mongokit';
import mongoose from 'mongoose';
import MusokInvoice from './musok.model.js';

class MusokInvoiceRepository extends Repository<InstanceType<typeof MusokInvoice>> {
  constructor() {
    super(MusokInvoice, [], { maxLimit: 100 });
  }

  /**
   * Atomic next serial — $inc on a dedicated counters collection.
   * Returns the formatted serial string + numeric value.
   */
  async nextSerial(branchCode: string, year: number): Promise<{ serial: string; number: number }> {
    const counter = await mongoose.connection
      .db!.collection('musok_counters')
      .findOneAndUpdate({ branchCode, year }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
    const num = counter!.seq as number;
    return { serial: formatMusokSerial(branchCode, year, num), number: num };
  }

  /**
   * Aggregate monthly VAT totals for Mushak 9.1 return.
   *
   * Routes through `aggregatePipeline` (mongokit 3.13+) so the
   * multi-tenant plugin's `before:aggregatePipeline` hook injects the
   * tenant `$match`. The pipeline's local `$match` carries date + status
   * filters only; orgId is layered in by the plugin from the options bag.
   */
  async aggregateMonthlyVat(year: number, month: number, organizationId?: string) {
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

    return this.aggregatePipeline<{
      _id: number;
      taxableBase: number;
      vatAmount: number;
      sdAmount: number;
      count: number;
    }>(
      [
        { $match: { date: { $gte: start, $lte: end }, status: 'issued' } },
        { $unwind: '$lines' },
        {
          $group: {
            _id: '$lines.vatRate',
            taxableBase: { $sum: '$lines.totalValue' },
            vatAmount: { $sum: '$lines.vatAmount' },
            sdAmount: { $sum: '$lines.sdAmount' },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: -1 } },
      ],
      organizationId ? { organizationId } : {},
    );
  }
}

const musokInvoiceRepository = new MusokInvoiceRepository();
export default musokInvoiceRepository;
