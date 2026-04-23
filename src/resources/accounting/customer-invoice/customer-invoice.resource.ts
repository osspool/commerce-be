/**
 * Customer Invoices Resource — read + Stripe action router
 *
 * State transitions (post / receive / debit-note) via declarative `actions` block.
 */
import { defineResource } from '@classytic/arc';
import { requireOrgMembership } from '@classytic/arc/permissions';
import type mongoose from 'mongoose';
import { Account, accounting } from '../accounting.engine.js';

type AnyReq = {
  query?: Record<string, string>;
  scope?: { organizationId?: string };
  user?: { organizationId?: string; orgId?: string };
  headers?: Record<string, string | undefined>;
};
type AnyReply = { send: (x: unknown) => unknown };

function getOrgId(req: AnyReq): string | undefined {
  return req.scope?.organizationId ?? req.user?.organizationId ?? req.user?.orgId ?? req.headers?.['x-organization-id'];
}

async function arAccountId(): Promise<mongoose.Types.ObjectId> {
  const acc = await Account.findOne({ accountTypeCode: '1141' }).select('_id').lean();
  if (!acc) throw new Error('A/R control account 1141 not seeded');
  return acc._id as mongoose.Types.ObjectId;
}

async function openInvoicesHandler(req: AnyReq, reply: AnyReply) {
  const orgId = getOrgId(req);
  const customerId = req.query?.customerId;
  const arId = await arAccountId();
  const open = await accounting.repositories.reconciliations.getOpenItems({
    accountId: arId,
    organizationId: orgId,
    ...(customerId ? { filter: { partnerId: customerId } } : {}),
  } as never);
  return reply.send({ success: true, data: open });
}

const customerInvoiceResource = defineResource({
  name: 'customer-invoice',
  displayName: 'Customer Invoices',
  tag: 'Accounting - Customer Invoices (A/R)',
  prefix: '/accounting/customer-invoices',
  disableDefaultRoutes: true,

  actions: (await import('./customer-invoice.actions.js')).customerInvoiceActions,
  actionPermissions: (await import('./customer-invoice.actions.js')).customerInvoiceActionPermissions,

  routes: [
    {
      method: 'GET',
      path: '/open',
      summary: 'List open A/R items (optionally filtered by customer)',
      permissions: requireOrgMembership(),
      raw: true,
      handler: openInvoicesHandler as any,
    },
  ],
});

export default customerInvoiceResource;
