/**
 * Journal Entry Action Registry — Stripe-style state transitions
 *
 * Registered via createActionRouter → POST /accounting/journal-entries/:id/action
 * Body: { action: "post" | "reverse" | "duplicate" | "archive", ... }
 *
 * Replaces the legacy PATCH /:id/post, /:id/reverse, /:id/unpost, POST /:id/duplicate
 * routes. Note: unpost is intentionally DROPPED — Odoo-correct semantics treat
 * posted entries as final. Use `reverse` to issue a forward correction (creates
 * a new posted counter-entry on `reversalDate`, which lands in the current open
 * period; the original stays posted with `reversed=true`).
 */

import type { FastifyRequest } from 'fastify';
import type { PermissionCheck } from '@classytic/arc/permissions';
import { roles } from '@classytic/arc/permissions';
import { getOrgId, getUserId } from '@classytic/arc/scope';
import { journalEntryRepository } from '../accounting.engine.js';

type ActionRequest = FastifyRequest & {
  user?: { _id?: string; id?: string };
};

function getIds(req: ActionRequest): { orgId: string | undefined; actorId: string | undefined } {
  const orgId = getOrgId(req.scope) ?? undefined;
  const actorId = getUserId(req.scope) ?? req.user?._id ?? req.user?.id ?? undefined;
  return { orgId, actorId };
}

export const journalEntryActionConfig = {
  name: 'journal-entries',
  tag: 'Accounting - Journal Entries',
  prefix: '/accounting/journal-entries',

  actions: {
    /** draft → posted */
    post: async (id: string, _data: Record<string, unknown>, req: ActionRequest) => {
      const { orgId, actorId } = getIds(req);
      return journalEntryRepository.post(id, orgId, { actorId });
    },

    /**
     * posted → posted (creates new counter-entry on `reversalDate`).
     * Original stays posted, marked `reversed=true`. Forward correction.
     */
    reverse: async (id: string, data: Record<string, unknown>, req: ActionRequest) => {
      const { orgId, actorId } = getIds(req);
      const reversalDate = data.reversalDate
        ? new Date(data.reversalDate as string)
        : undefined;
      return journalEntryRepository.reverse(id, orgId, { reversalDate, actorId });
    },

    /** any → new draft (clones items, fresh state, today's date) */
    duplicate: async (id: string, _data: Record<string, unknown>, req: ActionRequest) => {
      const { orgId } = getIds(req);
      return journalEntryRepository.duplicate(id, orgId);
    },

    /**
     * draft → archived. Posted entries cannot be archived (immutable);
     * use `reverse` instead. Preserves audit trail.
     */
    archive: async (id: string, _data: Record<string, unknown>, req: ActionRequest) => {
      const { orgId, actorId } = getIds(req);
      return journalEntryRepository.archive(id, orgId, { actorId });
    },
  },

  actionPermissions: {
    post: roles('admin', 'finance_admin'),
    reverse: roles('admin', 'finance_admin'),
    duplicate: roles('admin', 'finance_admin', 'staff'),
    archive: roles('admin'),
  } as Record<string, PermissionCheck>,

  actionSchemas: {
    reverse: {
      reversalDate: {
        type: 'string',
        format: 'date',
        description: 'Date for the reversal entry (defaults to today)',
      },
    },
  },

  /**
   * Surface period-lock errors as 409 (conflict). The day-close plugin throws
   * `PERIOD_LOCKED`; the ledger's built-in fiscalLockPlugin throws
   * `FISCAL_ERROR` (with statusCode 400, but semantically it's a conflict).
   * Both are mapped to 409 here so clients can distinguish "you tried to
   * post into a closed period" from generic 400 validation failures.
   */
  onError: (error: Error, action: string, _id: string) => {
    const code = (error as { code?: string }).code;
    if (code === 'PERIOD_LOCKED' || code === 'FISCAL_ERROR' || code === 'FISCAL_PERIOD_CLOSED') {
      return { statusCode: 409, error: error.message, code };
    }
    const status = (error as { statusCode?: number }).statusCode;
    return {
      statusCode: status ?? 400,
      error: error.message,
      code: code ?? `JOURNAL_ENTRY_${action.toUpperCase()}_FAILED`,
    };
  },
};
