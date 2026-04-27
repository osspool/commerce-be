/**
 * Journal Entry Action Registry — Stripe-style state transitions
 *
 * Wired via declarative `actions:` block → POST /accounting/journal-entries/:id/action
 * Body: { action: "post" | "reverse" | "duplicate" | "archive", ... }
 *
 * Replaces the legacy PATCH /:id/post, /:id/reverse, /:id/unpost, POST /:id/duplicate
 * routes. Note: unpost is intentionally DROPPED — Odoo-correct semantics treat
 * posted entries as final. Use `reverse` to issue a forward correction (creates
 * a new posted counter-entry on `reversalDate`, which lands in the current open
 * period; the original stays posted with `reversed=true`).
 */

import { requireRoles } from '@classytic/arc/permissions';
import { getOrgId, getUserId } from '@classytic/arc/scope';
import type { RequestWithExtras } from '@classytic/arc/types';
import { journalEntryRepository } from '../accounting.engine.js';

function getIds(req: RequestWithExtras): { orgId: string | undefined; actorId: string | undefined } {
  const orgId = getOrgId(req.scope) ?? undefined;
  const actorId = (getUserId(req.scope) ?? req.user?._id ?? req.user?.id ?? undefined) as string | undefined;
  return { orgId, actorId };
}

/**
 * Arc 2.8 declarative actions — imported by journal-entry.resource.ts.
 *
 * Period-lock errors (PERIOD_LOCKED, FISCAL_ERROR, FISCAL_PERIOD_CLOSED)
 * are surfaced as 409 (conflict) so clients can distinguish "you tried to
 * post into a closed period" from generic 400 validation failures.
 */
export const journalEntryActions = {
  /** draft → posted */
  post: {
    handler: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
      const { orgId, actorId } = getIds(req);
      return journalEntryRepository.post(id, orgId, { actorId });
    },
    permissions: requireRoles('admin', 'finance_admin'),
  },

  /**
   * posted → posted (creates new counter-entry on `reversalDate`).
   * Original stays posted, marked `reversed=true`. Forward correction.
   */
  reverse: {
    handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
      const { orgId, actorId } = getIds(req);
      const reversalDate = data.reversalDate ? new Date(data.reversalDate as string) : undefined;
      return journalEntryRepository.reverse(id, orgId, { reversalDate, actorId });
    },
    permissions: requireRoles('admin', 'finance_admin'),
    schema: {
      type: 'object',
      properties: {
        reversalDate: {
          type: 'string',
          format: 'date',
          description: 'Date for the reversal entry (defaults to today)',
        },
      },
      required: [],
    },
  },

  /** any → new draft (clones items, fresh state, today's date) */
  duplicate: {
    handler: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
      const { orgId } = getIds(req);
      return journalEntryRepository.duplicate(id, orgId);
    },
    permissions: requireRoles('admin', 'finance_admin', 'staff'),
  },

  /**
   * draft → archived. Posted entries cannot be archived (immutable);
   * use `reverse` instead. Preserves audit trail.
   */
  archive: {
    handler: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
      const { orgId, actorId } = getIds(req);
      return journalEntryRepository.archive(id, orgId, { actorId });
    },
    permissions: requireRoles('admin'),
  },
};
