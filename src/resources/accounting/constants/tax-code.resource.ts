/**
 * Tax Code Resource — BD Tax Code Lookups (Static)
 *
 * No database — returns VAT/TDS/VDS tax codes from @classytic/ledger-bd.
 *
 * GET /accounting/tax-codes                              — List all
 * GET /accounting/tax-codes/divisions                    — List BD divisions
 * GET /accounting/tax-codes/divisions/:division          — Tax codes for a division
 */

import { defineResource } from '@classytic/arc';
import { requireAuth } from '@classytic/arc/permissions';
import { BD_DIVISIONS, TAX_CODES, TAX_CODES_BY_DIVISION } from '@classytic/ledger-bd';
import { NotFoundError } from '@classytic/arc/utils';

type TaxCodeEntry = (typeof TAX_CODES)[keyof typeof TAX_CODES];

function normalizeDivision(raw: string): string | null {
  const lower = raw.toLowerCase().trim();
  const match = (BD_DIVISIONS as readonly string[]).find((d) => d.toLowerCase() === lower);
  return match ?? null;
}

function getTaxesForDivision(division: string) {
  const codes = (TAX_CODES_BY_DIVISION as Record<string, string[]>)[division];
  if (!codes) return [];
  return codes.map((code) => (TAX_CODES as Record<string, TaxCodeEntry>)[code]).filter(Boolean);
}

const taxCodeResource = defineResource({
  name: 'tax-code',
  displayName: 'Tax Codes',
  tag: 'Accounting',
  prefix: '/accounting/tax-codes',

  disableDefaultRoutes: true,
  skipValidation: true,

  routes: [
    {
      method: 'GET' as const,
      path: '/',
      summary: 'List all BD tax codes',
      permissions: requireAuth(),
      raw: true,
      handler: async () => {
        const allCodes = Object.values(TAX_CODES) as any[];
        return { results: allCodes.length, data: allCodes };
      },
    },

    {
      method: 'GET' as const,
      path: '/divisions',
      summary: 'List BD divisions',
      permissions: requireAuth(),
      raw: true,
      handler: async () => {
        return { data: BD_DIVISIONS };
      },
    },

    {
      method: 'GET' as const,
      path: '/divisions/:division',
      summary: 'Get tax codes for a BD division',
      permissions: requireAuth(),
      raw: true,
      handler: async (req: any, reply: any) => {
        const division = normalizeDivision(req.params.division);
        if (!division) {
          throw new NotFoundError(`Division '${req.params.division}' not found`);
        }
        const taxes = getTaxesForDivision(division);
        return { data: { division, taxes } };
      },
    },
  ],
});

export default taxCodeResource;
