/**
 * Vendor Bills Resource — read + Stripe action router
 *
 * State transitions (post / pay / credit-note) via declarative `actions` block.
 * Top-level defineResource — auto-discovered by loadResources().
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

async function apAccountId(): Promise<mongoose.Types.ObjectId> {
  const acc = await Account.findOne({ accountTypeCode: '2111' }).select('_id').lean();
  if (!acc) throw new Error('A/P control account 2111 not seeded');
  return acc._id as mongoose.Types.ObjectId;
}

async function openBillsHandler(req: AnyReq, reply: AnyReply) {
  const orgId = getOrgId(req);
  const supplierId = req.query?.supplierId;
  const apId = await apAccountId();
  const open = await accounting.repositories.reconciliations.getOpenItems({
    accountId: apId,
    organizationId: orgId,
    ...(supplierId ? { filter: { partnerId: supplierId } } : {}),
  } as never);
  return reply.send({ success: true, data: open });
}

const vendorBillResource = defineResource({
  name: 'vendor-bill',
  displayName: 'Vendor Bills',
  tag: 'Accounting - Vendor Bills (A/P)',
  prefix: '/accounting/vendor-bills',
  disableDefaultRoutes: true,

  actions: (await import('./vendor-bill.actions.js')).vendorBillActions,
  actionPermissions: (await import('./vendor-bill.actions.js')).vendorBillActionPermissions,

  routes: [
    {
      method: 'GET',
      path: '/open',
      summary: 'List open A/P items (optionally filtered by supplier)',
      permissions: requireOrgMembership(),
      raw: true,
      handler: openBillsHandler as any,
    },
  ],
});

export default vendorBillResource;
