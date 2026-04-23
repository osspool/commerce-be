import { type AnyDocument, type AnyModel, Repository } from '@classytic/mongokit';
import WithholdingCertificate from './withholding-certificate.model.js';

class WithholdingCertificateRepository extends Repository<AnyDocument> {
  constructor() {
    super(WithholdingCertificate as unknown as AnyModel, [], { maxLimit: 200 });
  }

  async getUnreconciledTotal(
    organizationId: string,
    type: 'VDS' | 'TDS',
    direction: 'ISSUED' | 'RECEIVED',
    period?: string,
  ): Promise<{ count: number; total: number }> {
    const match: Record<string, unknown> = {
      organizationId,
      type,
      direction,
      reconciled: false,
    };
    if (period) match.period = period;

    const result = await WithholdingCertificate.aggregate([
      { $match: match },
      { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$withholdingAmount' } } },
    ]);

    return result[0] ?? { count: 0, total: 0 };
  }

  async markReconciled(ids: string[], reconciledAt: Date = new Date()): Promise<number> {
    const result = await WithholdingCertificate.updateMany(
      { _id: { $in: ids }, reconciled: false },
      { $set: { reconciled: true, reconciledAt } },
    );
    return result.modifiedCount;
  }
}

export const withholdingCertificateRepository = new WithholdingCertificateRepository();
