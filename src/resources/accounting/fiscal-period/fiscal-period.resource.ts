/**
 * Fiscal Period Resource — CRUD + Close/Reopen
 *
 * Top-level defineResource — auto-discovered by loadResources().
 * Company-wide: tenantField:false.
 */

import { defineResource } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import { closeFiscalPeriod, reopenFiscalPeriod } from '@classytic/ledger';
import { createAdapter } from '#shared/adapter.js';
import { roles, requireAuth, denyAll } from '@classytic/arc/permissions';
import {
  bdPack,
  Account,
  JournalEntry,
  FiscalPeriod,
  fiscalPeriodRepository,
} from '../accounting.engine.js';

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
    create: roles('admin'),
    update: roles('admin'),
    delete: denyAll(),
  },

  additionalRoutes: [
    {
      method: 'PATCH' as const,
      path: '/:id/close',
      summary: 'Close a fiscal period',
      permissions: roles('admin'),
      wrapHandler: false,
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
      permissions: roles('admin'),
      wrapHandler: false,
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
