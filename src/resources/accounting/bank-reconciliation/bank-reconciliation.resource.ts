/**
 * Bank Reconciliation Resource (gap #5)
 *
 * Provides:
 *   - CRUD for BankStatement documents (statement header + embedded lines)
 *   - GET /open-items?bankAccountCode=XXXX  — unmatched JE items for the account
 *   - POST /:id/action { action: "matchLine" } — match a statement line to a JE item
 */

import { defineResource } from '@classytic/arc';
import { requireAuth, requireRoles } from '@classytic/arc/permissions';
import { ValidationError, NotFoundError } from '@classytic/arc/utils';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import type { AnyDocument } from '@classytic/mongokit';
import { QueryParser } from '@classytic/mongokit';
import type { Model } from 'mongoose';
import type { FastifyRequest } from 'fastify';
import mongoose from 'mongoose';
import { accounting, Account } from '../accounting.engine.js';
import { orgScoped } from '#shared/presets/index.js';
import BankStatement from './bank-statement.model.js';
import bankStatementRepository from './bank-statement.repository.js';

const authenticated = requireAuth();
const adminOnly = requireRoles('admin', 'branch_manager');

function resolveOrgId(req: FastifyRequest & { scope?: { organizationId?: string } }): string {
  const id = req.scope?.organizationId ?? (req.headers['x-organization-id'] as string | undefined);
  if (!id) throw new ValidationError('organizationId required — pass x-organization-id header');
  return id;
}

const bankReconciliationResource = defineResource({
  name: 'bank-reconciliation',
  displayName: 'Bank Reconciliation',
  tag: 'Accounting',
  prefix: '/accounting/bank-reconciliation',
  audit: true,
  presets: [orgScoped],

  adapter: createMongooseAdapter<AnyDocument>(
    BankStatement as unknown as Model<AnyDocument>,
    bankStatementRepository,
  ),

  queryParser: new QueryParser({
    maxLimit: 100,
    allowedFilterFields: ['status', 'bankAccountCode', 'statementDate'],
  }),

  permissions: {
    list: authenticated,
    get: authenticated,
    create: adminOnly,
    update: adminOnly,
    delete: adminOnly,
  },

  actions: {
    matchLine: {
      handler: async (id: string, data: Record<string, unknown>) => {
        const { lineIndex, jeEntryId, jeItemIndex, jeAccountId } = data as {
          lineIndex: number;
          jeEntryId: string;
          jeItemIndex: number;
          jeAccountId: string;
        };

        if (lineIndex === undefined || lineIndex === null)
          throw new ValidationError("'lineIndex' is required");
        if (!jeEntryId) throw new ValidationError("'jeEntryId' is required");
        if (jeItemIndex === undefined || jeItemIndex === null)
          throw new ValidationError("'jeItemIndex' is required");
        if (!jeAccountId) throw new ValidationError("'jeAccountId' is required");

        const stmt = await BankStatement.findById(id).lean();
        if (!stmt) throw new NotFoundError('BankStatement');

        const lines = (stmt.lines as unknown) as Array<Record<string, unknown>>;
        const line = lines[lineIndex];
        if (!line) throw new ValidationError(`Line index ${lineIndex} not found`);
        if (line.matchingNumber)
          throw new ValidationError('Line is already matched — unmatch first');

        const account = await Account.findOne({ accountNumber: jeAccountId }).lean();
        const accountId = account?._id ?? new mongoose.Types.ObjectId(jeAccountId);

        const reconciliation = await accounting.repositories.reconciliations.match({
          account: accountId,
          items: [{ entry: new mongoose.Types.ObjectId(jeEntryId), itemIndex: jeItemIndex }],
          organizationId: stmt.organizationId,
        });

        const recn = (reconciliation as Record<string, unknown>).matchingNumber as string;

        await BankStatement.findByIdAndUpdate(id, {
          [`lines.${lineIndex}.matchingNumber`]: recn,
          [`lines.${lineIndex}.jeEntryId`]: new mongoose.Types.ObjectId(jeEntryId),
          [`lines.${lineIndex}.jeItemIndex`]: jeItemIndex,
        });

        return { matchingNumber: recn };
      },
      permissions: adminOnly,
    },

    unmatchLine: {
      handler: async (id: string, data: Record<string, unknown>) => {
        const { lineIndex } = data as { lineIndex: number };
        if (lineIndex === undefined || lineIndex === null)
          throw new ValidationError("'lineIndex' is required");

        const stmt = await BankStatement.findById(id).lean();
        if (!stmt) throw new NotFoundError('BankStatement');

        const lines2 = (stmt.lines as unknown) as Array<Record<string, unknown>>;
        const line = lines2[lineIndex];
        if (!line) throw new ValidationError(`Line index ${lineIndex} not found`);
        const matchingNumber = line.matchingNumber as string | undefined;
        if (!matchingNumber) throw new ValidationError('Line is not matched');

        await accounting.repositories.reconciliations.unmatch({
          matchingNumber,
          organizationId: stmt.organizationId,
        });

        await BankStatement.findByIdAndUpdate(id, {
          [`lines.${lineIndex}.matchingNumber`]: null,
          [`lines.${lineIndex}.jeEntryId`]: null,
          [`lines.${lineIndex}.jeItemIndex`]: null,
        });

        return { unmatched: true };
      },
      permissions: adminOnly,
    },
  },

  routes: [
    {
      method: 'GET' as const,
      path: '/open-items',
      summary: 'Unmatched JE items for a bank account — use to find items to reconcile',
      permissions: authenticated,
      raw: true,
      handler: async (req: FastifyRequest, reply: { send: (v: unknown) => void }) => {
        const orgId = resolveOrgId(req as FastifyRequest & { scope?: { organizationId?: string } });
        const { bankAccountCode, asOfDate } = req.query as {
          bankAccountCode?: string;
          asOfDate?: string;
        };
        if (!bankAccountCode)
          throw new ValidationError("'bankAccountCode' query param is required");

        const account = await Account.findOne({ accountNumber: bankAccountCode }).lean();
        if (!account) throw new NotFoundError(`Account ${bankAccountCode}`);

        const items = await accounting.repositories.reconciliations.getOpenItems({
          accountId: account._id,
          organizationId: new mongoose.Types.ObjectId(orgId),
          ...(asOfDate ? { asOfDate: new Date(asOfDate) } : {}),
        });

        reply.send({ items });
      },
    },
  ],
});

export default bankReconciliationResource;
