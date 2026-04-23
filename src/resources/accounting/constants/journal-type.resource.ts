/**
 * Journal Type Resource — Journal Type Lookups (Static)
 *
 * No database — returns journal types from @classytic/ledger.
 *
 * GET /accounting/journal-types          — List all
 * GET /accounting/journal-types/:code    — Get single
 */

import { defineResource } from '@classytic/arc';
import { requireAuth } from '@classytic/arc/permissions';
import { getCustomJournalTypes, getJournalType, JOURNAL_TYPES } from '@classytic/ledger';

const journalTypeResource = defineResource({
  name: 'journal-type',
  displayName: 'Journal Types',
  tag: 'Accounting',
  prefix: '/accounting/journal-types',

  disableDefaultRoutes: true,
  skipValidation: true,

  routes: [
    {
      method: 'GET' as const,
      path: '/',
      summary: 'List all journal types',
      permissions: requireAuth(),
      raw: true,
      handler: async () => {
        const builtIn = Object.values(JOURNAL_TYPES);
        const custom = getCustomJournalTypes();
        const all = [...builtIn, ...custom];
        return {
          success: true,
          results: all.length,
          data: all.map((jt) => ({
            code: jt.code,
            name: jt.name,
            description: jt.description ?? null,
          })),
        };
      },
    },

    {
      method: 'GET' as const,
      path: '/:code',
      summary: 'Get journal type by code',
      permissions: requireAuth(),
      raw: true,
      handler: async (req: any, reply: any) => {
        const { code } = req.params;
        const journalType = getJournalType(code);
        if (!journalType) {
          return reply.status(404).send({ success: false, error: `Journal type '${code}' not found` });
        }
        return {
          success: true,
          data: { code: journalType.code, name: journalType.name, description: journalType.description ?? null },
        };
      },
    },
  ],
});

export default journalTypeResource;
