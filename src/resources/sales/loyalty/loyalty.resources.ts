/**
 * Loyalty wrapper resources — Member (customer-id mapping) + Self-service.
 *
 * These resources stay raw because they don't map cleanly to vanilla Arc
 * CRUD (member is keyed by `customerId`, not the engine's memberId; self
 * routes derive the subject from auth without an `:id` slot).
 *
 * State-transition verbs on memberResource (deactivate, reactivate, adjust,
 * tier override set/clear) are declared via Arc's `actions:` block and
 * mounted at `POST /:customerId/action`.
 *
 * Shared helpers live in [loyalty.utils.ts](./loyalty.utils.ts):
 *   - loyaltyCtx / resolveBranchCode — auth + branch resolution
 *   - loyaltyRoute — handleRaw wrapper with domain-error → HTTP-status mapping
 *   - loyaltyAction — same wrapper for the declarative `actions:` shape
 *
 * Referrals (with adapter + actions) live in `referral.resource.ts`.
 * Earning rules + tiers live in `earning-rule.resource.ts` / `tier.resource.ts`.
 */

import { defineResource } from '@classytic/arc';
import { ArcError } from '@classytic/arc/utils';
import type { FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import Customer from '../customers/customer.model.js';
import customerRepository from '../customers/customer.repository.js';
import * as bridge from './loyalty.bridge.js';
import { ensureLoyaltyEngine } from './loyalty.plugin.js';
import { memberSchemas, referralSchemas } from './loyalty.schemas.js';
import { loyaltyAction, loyaltyCtx, loyaltyRoute, resolveBranchCode } from './loyalty.utils.js';

const loyaltyEngine = await ensureLoyaltyEngine();

function engine() {
  return loyaltyEngine;
}

// ── Member Resource ──

export const memberResource = defineResource({
  name: 'loyalty-member',
  displayName: 'Loyalty Members',
  tag: 'Loyalty',
  prefix: '/loyalty/members',
  disableDefaultRoutes: true,

  // arc auto-mounts POST /:customerId/action with the discriminated body
  // schema. Action handlers receive the customerId via the first arg.
  actions: {
    deactivate: {
      handler: loyaltyAction(async (customerId, _data, req) =>
        bridge.deactivateCustomerMembership(customerId, loyaltyCtx(req)),
      ),
      permissions: permissions.customers.update,
    },
    reactivate: {
      handler: loyaltyAction(async (customerId, _data, req) =>
        bridge.reactivateCustomerMembership(customerId, loyaltyCtx(req)),
      ),
      permissions: permissions.customers.update,
    },
    adjust: {
      handler: loyaltyAction(async (customerId, data, req) => {
        const { points, reason } = data as { points: number; reason: string };
        const reqCtx = loyaltyCtx(req);
        const member = await bridge.requireMemberForCustomer(customerId, reqCtx);
        const tx = await engine().repositories.pointTransaction.adjustPoints(
          { memberId: member._id, points, description: reason, reason },
          reqCtx,
        );
        await bridge.syncCustomerMembership(customerId);
        req.log.info(
          {
            audit: true,
            op: 'loyalty.points.adjust',
            customerId,
            memberId: String(member._id),
            points,
            reason,
            balanceAfter: tx.balanceAfter,
            actorId: reqCtx.actorId,
            organizationId: reqCtx.organizationId,
          },
          'loyalty points adjusted',
        );
        return { transaction: tx, balanceAfter: tx.balanceAfter };
      }),
      permissions: permissions.customers.update,
      // Action `schema` is the BODY shape; loyalty.schemas wraps Fastify
      // route schemas as `{ params, body }`. Pass `.body` only.
      schema: memberSchemas.adjust.body,
    },
    set_tier_override: {
      handler: loyaltyAction(async (customerId, data, req) => {
        const { tier, reason } = data as { tier: string; reason: string };
        const reqCtx = loyaltyCtx(req);
        const member = await bridge.requireMemberForCustomer(customerId, reqCtx);
        const updated = await engine().repositories.tierDefinition.setOverride(member._id, tier, reason, reqCtx);
        await bridge.syncCustomerMembership(customerId);
        req.log.info(
          {
            audit: true,
            op: 'loyalty.tier-override.set',
            customerId,
            memberId: String(member._id),
            tier,
            reason,
            actorId: reqCtx.actorId,
            organizationId: reqCtx.organizationId,
          },
          'loyalty tier override set',
        );
        return updated;
      }),
      permissions: permissions.loyalty.memberOps,
      schema: memberSchemas.tierOverride.body,
    },
    clear_tier_override: {
      handler: loyaltyAction(async (customerId, _data, req) => {
        const reqCtx = loyaltyCtx(req);
        const member = await bridge.requireMemberForCustomer(customerId, reqCtx);
        const result = await engine().repositories.tierDefinition.clearOverride(member._id, reqCtx);
        await bridge.syncCustomerMembership(customerId);
        req.log.info(
          {
            audit: true,
            op: 'loyalty.tier-override.clear',
            customerId,
            memberId: String(member._id),
            actorId: reqCtx.actorId,
            organizationId: reqCtx.organizationId,
          },
          'loyalty tier override cleared',
        );
        return result;
      }),
      permissions: permissions.loyalty.memberOps,
    },
  },

  routes: [
    {
      method: 'POST',
      path: '/',
      summary: 'Enroll customer in loyalty program',
      permissions: permissions.customers.update,
      raw: true,
      schema: memberSchemas.enroll,
      handler: loyaltyRoute(async (req: FastifyRequest) => {
        const { customerId } = req.body as { customerId: string };
        const branchCode = await resolveBranchCode(req);
        return bridge.enrollCustomer(customerId, { ...loyaltyCtx(req), branchCode });
      }, 201),
    },
    {
      method: 'GET',
      path: '/by-card/:cardId',
      summary: 'Look up loyalty member + customer by printed card ID (POS card-share scan)',
      permissions: permissions.loyalty.view,
      raw: true,
      schema: memberSchemas.byCard,
      handler: loyaltyRoute(async (req: FastifyRequest) => {
        const { cardId } = req.params as { cardId: string };
        const member = await engine().repositories.member.getByQuery(
          { cardId },
          { throwOnNotFound: false },
        );
        if (!member) {
          throw new ArcError('Member not found for card', { code: 'MEMBER_NOT_FOUND', statusCode: 404 });
        }
        const customer = await customerRepository.getById(member.externalId, {
          lean: true,
          throwOnNotFound: false,
        });
        return { member, customer };
      }),
    },
    {
      method: 'GET',
      path: '/:customerId',
      summary: 'Get loyalty member + balance projection',
      permissions: permissions.customers.get,
      raw: true,
      handler: loyaltyRoute(async (req: FastifyRequest) => {
        const { customerId } = req.params as { customerId: string };
        const member = await bridge.getMemberForCustomer(customerId, loyaltyCtx(req));
        if (!member) {
          throw new ArcError('Not enrolled', { code: 'MEMBER_NOT_FOUND', statusCode: 404 });
        }
        const balance = {
          current: member.balance.current,
          lifetime: member.balance.lifetime,
          redeemed: member.balance.redeemed,
          expired: member.balance.expired,
          tier: member.tier,
          tierOverride: member.tierOverride,
        };
        return { member, balance };
      }),
    },
    {
      method: 'GET',
      path: '/:customerId/history',
      summary: 'Transaction history (convenience: customerId → memberId → query)',
      permissions: permissions.customers.get,
      raw: true,
      handler: loyaltyRoute(async (req: FastifyRequest) => {
        const { customerId } = req.params as { customerId: string };
        const { page = 1, limit = 20 } = req.query as { page?: number; limit?: number };
        const member = await bridge.requireMemberForCustomer(customerId, loyaltyCtx(req));
        return engine().repositories.pointTransaction.getAll({
          filters: { memberId: member._id },
          page: Number(page),
          limit: Math.min(Number(limit), 100),
          sort: { createdAt: -1 },
        });
      }),
    },
    {
      method: 'GET',
      path: '/:customerId/referrals',
      summary: 'Referrals by member (convenience projection)',
      permissions: permissions.customers.get,
      raw: true,
      handler: loyaltyRoute(async (req: FastifyRequest) => {
        const { customerId } = req.params as { customerId: string };
        const { page = 1, limit = 20 } = req.query as { page?: number; limit?: number };
        const member = await bridge.requireMemberForCustomer(customerId, loyaltyCtx(req));
        return engine().repositories.referral.getAll({
          filters: { referrerId: member._id },
          page: Number(page),
          limit: Math.min(Number(limit), 100),
        });
      }),
    },
    {
      method: 'POST',
      path: '/preview',
      summary: 'Forecast points for an order without persisting (dry-run of evaluateOrder)',
      permissions: permissions.customers.get,
      raw: true,
      handler: loyaltyRoute(async (req: FastifyRequest) => {
        const body = req.body as {
          customerId?: string;
          orderTotal?: number;
          items?: Array<{ categoryId?: string; amount: number; quantity: number }>;
        };
        if (!body?.customerId || typeof body.orderTotal !== 'number') {
          throw new ArcError('customerId and orderTotal required', { code: 'BAD_REQUEST', statusCode: 400 });
        }
        return bridge.previewPointsForOrder({
          customerId: body.customerId,
          orderTotal: body.orderTotal,
          items: body.items,
        });
      }),
    },
  ],
});

// ── Self-service Resource ──

export const loyaltySelfResource = defineResource({
  name: 'loyalty-self',
  displayName: 'My Loyalty',
  tag: 'Loyalty',
  prefix: '/loyalty/me',
  disableDefaultRoutes: true,
  routes: [
    {
      method: 'POST',
      path: '/enroll',
      summary: 'Self-enroll in loyalty program',
      permissions: permissions.customers.getMe,
      raw: true,
      handler: loyaltyRoute(async (req: FastifyRequest) => {
        const user = (req as { user?: { _id?: string; id?: string } }).user;
        const userId = user?._id || user?.id;
        if (!userId) {
          throw new ArcError('Authentication required', { code: 'UNAUTHENTICATED', statusCode: 401 });
        }
        let customer = await customerRepository.getByUserId(userId);
        if (!customer) customer = await customerRepository.linkOrCreateForUser(user);
        if (!customer) {
          throw new ArcError('Could not find or create customer profile', {
            code: 'CUSTOMER_NOT_FOUND',
            statusCode: 404,
          });
        }
        const branchCode = await resolveBranchCode(req);
        return bridge.enrollCustomer(customer._id as unknown as string, { actorId: userId, branchCode });
      }, 201),
    },
    {
      method: 'GET',
      path: '/',
      summary: 'Get my loyalty status',
      permissions: permissions.customers.getMe,
      raw: true,
      handler: loyaltyRoute(async (req: FastifyRequest) => {
        const user = (req as { user?: { _id?: string; id?: string } }).user;
        const userId = user?._id || user?.id;
        if (!userId) {
          throw new ArcError('Authentication required', { code: 'UNAUTHENTICATED', statusCode: 401 });
        }
        const customer = await customerRepository.getByUserId(userId);
        if (!customer) {
          throw new ArcError('Customer profile not found', { code: 'CUSTOMER_NOT_FOUND', statusCode: 404 });
        }
        const member = await bridge.getMemberForCustomer(customer._id as unknown as string, loyaltyCtx(req));
        if (!member) return { enrolled: false };
        const balance = {
          current: member.balance.current,
          lifetime: member.balance.lifetime,
          redeemed: member.balance.redeemed,
          expired: member.balance.expired,
          tier: member.tier,
          tierOverride: member.tierOverride,
        };
        return { enrolled: true, member, balance };
      }),
    },
    {
      method: 'POST',
      path: '/referral',
      summary: 'Apply a referral code (self-service)',
      permissions: permissions.customers.getMe,
      raw: true,
      schema: referralSchemas.selfRecord,
      handler: loyaltyRoute(async (req: FastifyRequest) => {
        const user = (req as { user?: { _id?: string; id?: string } }).user;
        const userId = user?._id || user?.id;
        if (!userId) {
          throw new ArcError('Authentication required', { code: 'UNAUTHENTICATED', statusCode: 401 });
        }
        const { referralCode } = req.body as { referralCode: string };
        const customer = await customerRepository.getByUserId(userId);
        if (!customer) {
          throw new ArcError('Customer profile not found', { code: 'CUSTOMER_NOT_FOUND', statusCode: 404 });
        }
        return engine().repositories.referral.recordReferral(
          { referralCode, refereeExternalId: customer._id as unknown as string, refereeExternalType: 'customer' },
          loyaltyCtx(req),
        );
      }, 201),
    },
  ],
});
