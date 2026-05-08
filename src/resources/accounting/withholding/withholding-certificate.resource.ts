import { defineResource } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { requireAuth, requireRoles } from '@classytic/arc/permissions';
import { type AnyDocument, QueryParser } from '@classytic/mongokit';
import type { Model } from 'mongoose';
import { orgScoped } from '#shared/presets/index.js';
import WithholdingCertificate from './withholding-certificate.model.js';
import { withholdingCertificateRepository } from './withholding-certificate.repository.js';

const authenticated = requireAuth();

const withholdingCertificateResource = defineResource({
  name: 'withholding-certificate',
  displayName: 'Withholding Certificates (VDS/TDS)',
  tag: 'Accounting',
  prefix: '/accounting/withholding-certificates',
  audit: true,
  tenantField: 'organizationId',
  presets: [orgScoped],
  // The repo intentionally uses `Repository<AnyDocument>` (no per-field
  // typing for this resource — query/update is index-driven). Pin the
  // adapter's TDoc generic to match so it doesn't try to infer a stricter
  // shape from the model.
  adapter: createMongooseAdapter<AnyDocument>(
    WithholdingCertificate as unknown as Model<AnyDocument>,
    withholdingCertificateRepository,
  ),
  queryParser: new QueryParser({
    maxLimit: 200,
    allowedFilterFields: [
      'type',
      'direction',
      'period',
      'counterpartyTin',
      'reconciled',
      'certificateDate',
      'sourceId',
    ],
  }),
  permissions: {
    list: authenticated,
    get: authenticated,
    create: authenticated,
    update: requireRoles('admin', 'branch_manager'),
    delete: requireRoles('admin'),
  },
  actions: {
    reconcile: {
      handler: async (id, _data, _req) => {
        const count = await withholdingCertificateRepository.markReconciled([id]);
        return { reconciled: count };
      },
      permissions: requireRoles('admin', 'branch_manager'),
      description: 'Mark a certificate as reconciled against a return filing',
    },
  },
  routes: [
    {
      method: 'GET',
      path: '/summary',
      summary: 'Unreconciled withholding totals for return filing',
      permissions: authenticated,
      raw: true,
      handler: async (req: any) => {
        const orgId = req.scope?.organizationId || req.query?.branchId;
        const { type = 'VDS', direction = 'RECEIVED', period } = req.query;
        const result = await withholdingCertificateRepository.getUnreconciledTotal(orgId, type, direction, period);
        return { data: result };
      },
    },
  ],
});

export default withholdingCertificateResource;
