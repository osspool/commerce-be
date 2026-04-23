/**
 * Fiscal Period Resource — CRUD + Close/Reopen
 *
 * Top-level defineResource — auto-discovered by loadResources().
 * Company-wide: tenantField:false.
 */

import { defineResource } from '@classytic/arc';
import { denyAll, requireAuth, requireRoles } from '@classytic/arc/permissions';
import { closeFiscalPeriod, reopenFiscalPeriod } from '@classytic/ledger';
import { QueryParser } from '@classytic/mongokit';
import { createAdapter } from '#shared/adapter.js';
import { Account, bdPack, FiscalPeriod, fiscalPeriodRepository, JournalEntry } from '../accounting.engine.js';

const queryParser = new QueryParser({ maxLimit: 100 });

const fiscalPeriodResource = defineResource({
  name: 'fiscal-period',
  audit: true,
  displayName: 'Fiscal Periods',
  tag: 'Accounting',
  prefix: '/accounting/fiscal-periods',

  adapter: createAdapter(FiscalPeriod, fiscalPeriodRepository),
  queryParser,
  tenantField: false, // company-wide

  permissions: {
    list: requireAuth(),
    get: requireAuth(),
    create: requireRoles('admin'),
    update: requireRoles('admin'),
    delete: denyAll(),
  },

  routes: [
    {
      method: 'PATCH' as const,
      path: '/:id/close',
      summary: 'Close a fiscal period',
      permissions: requireRoles('admin'),
      raw: true,
      handler: async (req: any, reply: any) => {
        const userId = req.scope?.userId || req.user?.id;
        const result = await closeFiscalPeriod(
          {
            AccountModel: Account,
            JournalEntryModel: JournalEntry,
            FiscalPeriodModel: FiscalPeriod,
            country: bdPack,
          },
          { periodId: req.params.id, closedBy: userId },
        );
        return reply.send({ success: true, data: result });
      },
    },
    {
      method: 'PATCH' as const,
      path: '/:id/reopen',
      summary: 'Reopen a closed fiscal period',
      permissions: requireRoles('admin'),
      raw: true,
      handler: async (req: any, reply: any) => {
        const userId = req.scope?.userId || req.user?.id;
        const result = await reopenFiscalPeriod(
          {
            FiscalPeriodModel: FiscalPeriod,
            JournalEntryModel: JournalEntry,
          },
          { periodId: req.params.id, reopenedBy: userId },
        );
        return reply.send({ success: true, data: result });
      },
    },
  ],
});

export default fiscalPeriodResource;
