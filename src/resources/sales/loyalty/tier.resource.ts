/**
 * Loyalty Tiers Resource — modern Arc adapter + custom evaluate route.
 *
 * Auto-CRUD via mongokit adapter (list/get/create/update/delete).
 * Bulk evaluation (`POST /evaluate`) is a custom non-CRUD route — recomputes
 * tier assignments for all members. Not per-id, so it's a `routes:` entry,
 * not an `actions:` verb.
 */

import { defineResource } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import type { FastifyReply, FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import { queryParser } from '#shared/query-parser.js';
import { ensureLoyaltyEngine } from './loyalty.plugin.js';
import { ValidationError } from '@classytic/arc/utils';

const engine = await ensureLoyaltyEngine();

function ctxFromReq(req: FastifyRequest) {
  const user = (req as { user?: { _id?: string; id?: string; organizationId?: string; orgId?: string } }).user;
  const actorId = (user?._id || user?.id || 'anonymous') as string;
  const organizationId =
    (req.headers['x-organization-id'] as string | undefined) || user?.organizationId || user?.orgId;
  return organizationId ? { actorId, organizationId } : { actorId };
}

const tierResource = defineResource({
  name: 'loyalty-tier',
  displayName: 'Loyalty Tiers',
  tag: 'Loyalty',
  prefix: '/loyalty/tiers',
  audit: true,

  // Loyalty is company-wide (one tier ladder across all branches — see
  // loyalty.plugin.ts). `tenantField: false` keeps the adapter from
  // injecting an org filter on reads.
  tenantField: false,

  adapter: createMongooseAdapter(engine.models.TierDefinition as never, engine.repositories.tierDefinition as never),
  queryParser,

  permissions: {
    list: permissions.loyalty.view,
    get: permissions.loyalty.view,
    create: permissions.loyalty.manage,
    update: permissions.loyalty.manage,
    delete: permissions.loyalty.manage,
  },

  routes: [
    {
      method: 'POST',
      path: '/evaluate',
      summary: 'Recompute tier assignments for all members',
      permissions: permissions.loyalty.manage,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        try {
          const result = await engine.repositories.tierDefinition.evaluateAll(ctxFromReq(req));
          return reply.send(result);
        } catch (err) {
          const e = err as { message?: string };
          throw new ValidationError(e.message ?? 'Tier evaluation failed');
        }
      },
    },
  ],
});

export default tierResource;
