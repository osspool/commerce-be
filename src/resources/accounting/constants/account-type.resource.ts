/**
 * Account Type Resource — BD Account Type Lookups (Static)
 *
 * No database — returns BFRS account types from @classytic/ledger-bd.
 *
 * GET /accounting/account-types          — List all (filterable)
 * GET /accounting/account-types/:code    — Get single by code
 */

import { defineResource } from '@classytic/arc';
import { requireAuth } from '@classytic/arc/permissions';
import { BD_ACCOUNT_TYPES } from '@classytic/ledger-bd';

function mapAccountType(at: any) {
  return {
    code: at.code,
    name: at.name,
    description: at.description ?? null,
    category: at.category,
    parentCode: at.parentCode ?? null,
    isTotal: at.isTotal ?? false,
    isGroup: at.isGroup ?? false,
    deprecated: at.deprecated ?? false,
    replacedBy: at.replacedBy ?? null,
    taxMetadata: at.taxMetadata ?? null,
    cashFlowCategory: at.cashFlowCategory ?? null,
  };
}

const accountTypeResource = defineResource({
  name: 'account-type',
  displayName: 'Account Types',
  tag: 'Accounting',
  prefix: '/accounting/account-types',

  disableDefaultRoutes: true,
  skipValidation: true,

  additionalRoutes: [
    {
      method: 'GET' as const,
      path: '/',
      summary: 'List all BFRS account types',
      permissions: requireAuth(),
      wrapHandler: false,
      handler: async (req: any) => {
        const { search, category, mainType } = req.query as any;
        let accountTypes = (BD_ACCOUNT_TYPES as any[]).map(mapAccountType);

        if (search) {
          const s = String(search).toLowerCase();
          accountTypes = accountTypes.filter(
            (at) => at.code.toLowerCase().includes(s) || at.name.toLowerCase().includes(s),
          );
        }
        if (category) {
          accountTypes = accountTypes.filter((at) => at.category === category);
        }
        if (mainType) {
          accountTypes = accountTypes.filter((at) => at.category.endsWith(`-${mainType}`));
        }

        return { success: true, results: accountTypes.length, data: accountTypes };
      },
    },

    {
      method: 'GET' as const,
      path: '/:code',
      summary: 'Get account type by code',
      permissions: requireAuth(),
      wrapHandler: false,
      handler: async (req: any, reply: any) => {
        const { code } = req.params;
        const accountType = (BD_ACCOUNT_TYPES as any[]).find((at) => at.code === code);
        if (!accountType) {
          return reply.status(404).send({ success: false, error: `Account type '${code}' not found` });
        }
        return {
          success: true,
          data: { ...mapAccountType(accountType), totalAccountTypes: accountType.totalAccountTypes ?? null },
        };
      },
    },
  ],
});

export default accountTypeResource;
