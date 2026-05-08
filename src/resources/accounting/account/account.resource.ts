/**
 * Account Resource — Chart of Accounts CRUD + Stripe-style actions
 *
 * Top-level defineResource — auto-discovered by loadResources().
 * Engine is initialized in app.ts before loadResources, so the model is
 * available when this file is imported.
 *
 * Company-wide: tenantField:false disables Arc's default org query scoping.
 *
 * State transitions (`enable`, `disable`) are declarative actions exposed as
 * `POST /:id/action { action: "enable" | "disable" }`. Bulk operations
 * (`/seed`, `/bulk`) stay as custom raw routes because they're not id-keyed —
 * arc's action contract is `POST /:id/action`, which doesn't fit collection-
 * level work.
 */

import { defineResource } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { requireAuth, requireRoles } from '@classytic/arc/permissions';
import type { RequestWithExtras } from '@classytic/arc/types';
import { QueryParser } from '@classytic/mongokit';
import { Account, accountRepository, JournalEntry } from '../accounting.engine.js';

// Pagination cap (1000) is set on the engine's `pagination.account` config
// in accounting.engine.ts. This QueryParser only validates query syntax.
const queryParser = new QueryParser();

const adminOnly = requireRoles('admin');

const accountResource = defineResource({
  name: 'account',
  audit: true,
  displayName: 'Chart of Accounts',
  tag: 'Accounting',
  prefix: '/accounting/accounts',

  adapter: createMongooseAdapter(Account, accountRepository),
  queryParser,
  tenantField: false,

  permissions: {
    list: requireAuth(),
    get: requireAuth(),
    create: adminOnly,
    update: adminOnly,
    delete: adminOnly,
  },

  schemaOptions: {
    excludeFields: ['organizationId'],
  },

  actions: {
    enable: {
      handler: async (id: string, _data: Record<string, unknown>, _req: RequestWithExtras) => {
        const account = await accountRepository.getById(id);
        if (!account) {
          throw Object.assign(new Error('Account not found'), {
            statusCode: 404,
            code: 'ACCOUNT_NOT_FOUND',
          });
        }
        return accountRepository.update(id, { active: true });
      },
      permissions: adminOnly,
    },
    disable: {
      handler: async (id: string, _data: Record<string, unknown>, _req: RequestWithExtras) => {
        const account = await accountRepository.getById(id);
        if (!account) {
          throw Object.assign(new Error('Account not found'), {
            statusCode: 404,
            code: 'ACCOUNT_NOT_FOUND',
          });
        }
        // Accounts are company-wide; block disable if ANY branch has journal
        // entries referencing this account. Unscoped exists() is intentional.
        const hasEntries = await JournalEntry.exists({ 'journalItems.account': id });
        if (hasEntries) {
          throw Object.assign(new Error('Cannot disable account with existing journal entries'), {
            statusCode: 400,
            code: 'ACCOUNT_HAS_ENTRIES',
          });
        }
        return accountRepository.update(id, { active: false });
      },
      permissions: adminOnly,
    },
  },

  routes: [
    {
      method: 'POST' as const,
      path: '/seed',
      summary: 'Seed default BFRS chart of accounts (company-wide)',
      permissions: adminOnly,
      raw: true,
      // biome-ignore lint/suspicious/noExplicitAny: bulk seed handler — no id, no body
      handler: async (_req: any, reply: any) => {
        const result = await accountRepository.seedAccounts(undefined);
        return reply.status(201).send(result);
      },
    },
    {
      method: 'POST' as const,
      path: '/bulk',
      summary: 'Bulk create accounts',
      permissions: adminOnly,
      raw: true,
      // biome-ignore lint/suspicious/noExplicitAny: bulk-create handler with array body
      handler: async (req: any, reply: any) => {
        const { accounts } = req.body;
        const result = await accountRepository.bulkCreate(accounts, undefined);
        const status = result.summary?.created > 0 ? 201 : 200;
        return reply.status(status).send(result);
      },
    },
  ],
});

export default accountResource;
