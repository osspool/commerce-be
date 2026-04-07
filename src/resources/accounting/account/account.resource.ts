/**
 * Account Resource — Chart of Accounts CRUD + Custom Actions
 *
 * Top-level defineResource — auto-discovered by loadResources().
 * Engine is initialized in app.ts before loadResources, so the model is
 * available when this file is imported.
 *
 * Company-wide: tenantField:false disables Arc's default org query scoping.
 */

import { defineResource } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import { createAdapter } from '#shared/adapter.js';
import { roles, requireAuth } from '@classytic/arc/permissions';
import { Account, JournalEntry, accountRepository } from '../accounting.engine.js';

// Pagination cap (1000) is set on the engine's `pagination.account` config
// in accounting.engine.ts. This QueryParser only validates query syntax.
const queryParser = new QueryParser();

const accountResource = defineResource({
  name: 'account',
  audit: true,
  displayName: 'Chart of Accounts',
  tag: 'Accounting',
  prefix: '/accounting/accounts',

  adapter: createAdapter(Account, accountRepository),
  queryParser,
  tenantField: false,

  permissions: {
    list: requireAuth(),
    get: requireAuth(),
    create: roles('admin'),
    update: roles('admin'),
    delete: roles('admin'),
  },

  schemaOptions: {
    excludeFields: ['organizationId'],
  },

  additionalRoutes: [
    {
      method: 'POST' as const,
      path: '/seed',
      summary: 'Seed default BFRS chart of accounts (company-wide)',
      permissions: roles('admin'),
      wrapHandler: false,
      handler: async (_req: any, reply: any) => {
        const result = await accountRepository.seedAccounts(undefined);
        return reply.status(201).send({ success: true, data: result });
      },
    },
    {
      method: 'POST' as const,
      path: '/bulk',
      summary: 'Bulk create accounts',
      permissions: roles('admin'),
      wrapHandler: false,
      handler: async (req: any, reply: any) => {
        const { accounts } = req.body;
        const result = await accountRepository.bulkCreate(accounts, undefined);
        const status = result.summary?.created > 0 ? 201 : 200;
        return reply.status(status).send({ success: true, data: result });
      },
    },
    {
      method: 'PATCH' as const,
      path: '/:id/enable',
      summary: 'Enable an account',
      permissions: roles('admin'),
      wrapHandler: false,
      handler: async (req: any, reply: any) => {
        const account = await Account.findById(req.params.id);
        if (!account) return reply.status(404).send({ error: 'Account not found' });
        const doc = await accountRepository.update(req.params.id, { active: true });
        return reply.send({ success: true, data: doc });
      },
    },
    {
      method: 'PATCH' as const,
      path: '/:id/disable',
      summary: 'Disable an account',
      permissions: roles('admin'),
      wrapHandler: false,
      handler: async (req: any, reply: any) => {
        const account = await Account.findById(req.params.id);
        if (!account) return reply.status(404).send({ error: 'Account not found' });
        const hasEntries = await JournalEntry.findOne({ 'journalItems.account': req.params.id }).lean();
        if (hasEntries) return reply.status(400).send({ error: 'Cannot disable account with existing journal entries' });
        const doc = await accountRepository.update(req.params.id, { active: false });
        return reply.send({ success: true, data: doc });
      },
    },
  ],
});

export default accountResource;
