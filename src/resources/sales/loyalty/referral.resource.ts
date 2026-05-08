/**
 * Loyalty Referral Resource — modern Arc adapter + actions, extracted from
 * loyalty.resources.ts (which used to host all referral routes as raw
 * handlers with hand-rolled try/catch envelopes).
 *
 * Auto-CRUD via adapter (list/get/update/delete). Two state-transition
 * actions (`approve`, `reject`) cover the FSM. Two routes stay raw:
 *   - POST `/record`  records a referral by `referralCode` + referee —
 *     domain verb (self-referral check, dual-side reward issuance) on the
 *     ReferralRepository, not a vanilla insert. Adapter create is disabled
 *     so this is the only legitimate create path.
 *   - GET `/lookup/:code`  alt-key lookup (by referral code, not _id).
 *
 * Filter `?referrerId=<memberId>` to scope to a member's referrals.
 */

import { defineResource } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { ArcError } from '@classytic/arc/utils';
import { QueryParser } from '@classytic/mongokit';
import type { FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import { ensureLoyaltyEngine } from './loyalty.plugin.js';
import { referralSchemas } from './loyalty.schemas.js';
import { loyaltyAction, loyaltyCtx, loyaltyRoute } from './loyalty.utils.js';

const engine = await ensureLoyaltyEngine();

const queryParser = new QueryParser({
  maxLimit: 100,
  allowedFilterFields: ['referrerId', 'refereeExternalId', 'refereeExternalType', 'status'],
  allowedSortFields: ['createdAt', 'approvedAt', 'rejectedAt'],
});

export default defineResource({
  name: 'loyalty-referral',
  displayName: 'Loyalty Referrals',
  tag: 'Loyalty',
  prefix: '/loyalty/referrals',
  audit: true,

  // Loyalty is company-wide — a referral made at one branch credits the
  // referrer regardless of which branch their friend redeems at. See
  // loyalty.plugin.ts for the design rationale.
  tenantField: false,

  adapter: createMongooseAdapter(engine.models.Referral as never, engine.repositories.referral as never),
  queryParser,
  // Adapter `create` is disabled — the only legitimate create path is the
  // explicit `POST /record` route below, which runs the `recordReferral`
  // domain verb (self-referral check, dual-side reward issuance). A
  // dedicated path keeps the URL self-documenting and avoids fighting the
  // adapter's POST `/` slot.
  disabledRoutes: ['create'],

  permissions: {
    list: permissions.customers.get,
    get: permissions.customers.get,
    update: permissions.loyalty.memberOps,
    delete: permissions.loyalty.memberOps,
  },

  actions: {
    approve: {
      handler: loyaltyAction(async (id, _data, req) => {
        const reqCtx = loyaltyCtx(req);
        const referral = await engine.repositories.referral.approve(id, reqCtx);
        req.log.info(
          {
            audit: true,
            op: 'loyalty.referral.approve',
            referralId: id,
            actorId: reqCtx.actorId,
            organizationId: reqCtx.organizationId,
          },
          'loyalty referral approved',
        );
        return referral;
      }),
      permissions: permissions.loyalty.memberOps,
    },
    reject: {
      handler: loyaltyAction(async (id, data, req) => {
        const reqCtx = loyaltyCtx(req);
        const { reason } = data as { reason: string };
        const referral = await engine.repositories.referral.reject(id, reason, reqCtx);
        req.log.info(
          {
            audit: true,
            op: 'loyalty.referral.reject',
            referralId: id,
            reason,
            actorId: reqCtx.actorId,
            organizationId: reqCtx.organizationId,
          },
          'loyalty referral rejected',
        );
        return referral;
      }),
      permissions: permissions.loyalty.memberOps,
      // Action `schema` is the BODY shape; loyalty.schemas wraps Fastify
      // route schemas as `{ params, body }`. Pass `.body` only.
      schema: referralSchemas.reject.body,
    },
  },

  routes: [
    {
      method: 'POST',
      path: '/record',
      summary: 'Record a referral (domain verb — runs validation + dual rewards)',
      permissions: permissions.customers.update,
      raw: true,
      schema: referralSchemas.record,
      handler: loyaltyRoute(async (req: FastifyRequest) => {
        const { referralCode, refereeCustomerId } = req.body as {
          referralCode: string;
          refereeCustomerId: string;
        };
        return engine.repositories.referral.recordReferral(
          { referralCode, refereeExternalId: refereeCustomerId, refereeExternalType: 'customer' },
          loyaltyCtx(req),
        );
      }, 201),
    },
    {
      method: 'GET',
      path: '/lookup/:code',
      summary: 'Lookup referral code (alt-key)',
      permissions: permissions.customers.get,
      raw: true,
      handler: loyaltyRoute(async (req: FastifyRequest) => {
        const { code } = req.params as { code: string };
        const member = await engine.repositories.referral.lookupByCode(code, loyaltyCtx(req));
        if (!member) {
          throw new ArcError('Referral code not found', { code: 'REFERRAL_NOT_FOUND', statusCode: 404 });
        }
        return { referrerMemberId: member._id };
      }),
    },
  ],
});
