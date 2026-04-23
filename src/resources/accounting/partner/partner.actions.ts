/**
 * Partner Action Registry — partner-level A/P + A/R actions
 *
 * Registered via createActionRouter → POST /accounting/partners/:id/action
 *   id   = supplier or customer ObjectId (string)
 *   body = { action: "open-balance", side: "supplier" | "customer", amount, asOf?, reason? }
 *
 * Today: opening balances only. Future home for credit-limit updates,
 * partner merges, dunning policy changes — anything that's a state
 * transition on a partner relationship from the A/P or A/R perspective.
 */

import { requireRoles } from '@classytic/arc/permissions';
import { getOrgId, getUserId } from '@classytic/arc/scope';
import type { RequestWithExtras } from '@classytic/arc/types';
import {
  openingBalanceToPosting,
  type PartnerSide,
  validateOpeningBalance,
} from '../posting/contracts/opening-balance.contract.js';
import { createPosting, SYSTEM_ACTOR_ID } from '../posting/posting.service.js';

function getIds(req: RequestWithExtras): { orgId: string | undefined; actorId: string } {
  const orgId = getOrgId(req.scope) ?? undefined;
  const actorId = (getUserId(req.scope) ?? req.user?._id ?? req.user?.id ?? SYSTEM_ACTOR_ID) as string;
  return { orgId, actorId };
}

async function openBalanceAction(partnerId: string, data: Record<string, unknown>, req: RequestWithExtras) {
  const { orgId, actorId } = getIds(req);
  const side = data.side as string;

  // Throws on invalid input — onError maps to 400 with the message.
  validateOpeningBalance({
    side,
    partnerId,
    amount: data.amount,
  });

  const posting = openingBalanceToPosting({
    side: side as PartnerSide,
    partnerId,
    amount: data.amount as number,
    asOf: data.asOf ? new Date(data.asOf as string) : undefined,
    reason: data.reason as string | undefined,
  });
  return createPosting(orgId, { ...posting, actorId });
}

/**
 * Arc 2.8 declarative actions — imported by partner.resource.ts.
 */
export const partnerActions = {
  'open-balance': {
    handler: openBalanceAction,
    permissions: requireRoles('admin', 'finance_admin'),
    schema: {
      type: 'object',
      properties: {
        side: { type: 'string', enum: ['supplier', 'customer'], description: "'supplier' or 'customer'" },
        amount: { type: 'integer', minimum: 1, description: 'Opening balance in paisa' },
        asOf: { type: 'string', format: 'date', description: 'Date (default Dec 31 last year)' },
        reason: { type: 'string', description: 'Audit reason for the migration entry' },
      },
      required: ['side', 'amount'],
    },
  },
};
