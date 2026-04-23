/**
 * Loyalty wrapper resources — Member (customer-id mapping) + Self-service + Referrals.
 *
 * These resources stay raw because they don't map cleanly to vanilla Arc CRUD:
 *   - **member**: keyed by `customerId` (be-prod's Customer model id), translated
 *     to memberId via the bridge. Includes customer-membership projection sync.
 *   - **loyalty-self**: customer derived from the authenticated user; no `:id` slot.
 *   - **referral**: `recordReferral` is a domain verb (validates self-referral,
 *     applies dual-side rewards); not a vanilla insert.
 *
 * Earning Rules and Tiers — which DO have vanilla CRUD shapes — moved to
 * `earning-rule.resource.ts` and `tier.resource.ts` using the modern
 * `adapter + actions` pattern.
 */

import { defineResource } from '@classytic/arc';
import type { FastifyReply, FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import Branch from '#resources/commerce/branch/branch.model.js';
import customerRepository from '../customers/customer.repository.js';
import * as bridge from './loyalty.bridge.js';
import { ensureLoyaltyEngine } from './loyalty.plugin.js';
import { memberSchemas, referralSchemas } from './loyalty.schemas.js';

const loyaltyEngine = await ensureLoyaltyEngine();

// ── Helpers (like flowCtx / flow in warehouse) ──

function engine() {
  return loyaltyEngine;
}

function ctx(req: FastifyRequest) {
  const user = (req as any).user;
  const actorId = (user?._id || user?.id || 'anonymous') as string;
  const organizationId =
    (req.headers['x-organization-id'] as string | undefined) || user?.organizationId || user?.orgId;
  return organizationId ? { actorId, organizationId } : { actorId };
}

async function resolveBranchCode(req: FastifyRequest): Promise<string | undefined> {
  const user = (req as any).user;
  const orgId = (req.headers['x-organization-id'] as string) || user?.organizationId || user?.orgId;
  if (!orgId) return undefined;
  const branch = await Branch.findById(orgId).select('code').lean();
  return (branch as { code?: string } | null)?.code || undefined;
}

function mapError(err: any): number {
  if (err.code === 'MEMBER_ALREADY_ENROLLED') return 409;
  if (err.code === 'MEMBER_NOT_FOUND' || err.message?.includes('not found') || err.message?.includes('not enrolled'))
    return 404;
  if (err.code === 'DUPLICATE_REFERRAL') return 409;
  if (err.code === 'SELF_REFERRAL' || err.code === 'CIRCULAR_REFERRAL' || err.code === 'MEMBER_INACTIVE') return 422;
  if (err.code === 'REFERRAL_LIMIT_EXCEEDED') return 429;
  if (err.code === 'INSUFFICIENT_POINTS' || err.code === 'VALIDATION_ERROR') return 400;
  if (err.code === 'RULE_NOT_FOUND' || err.code === 'TIER_NOT_FOUND' || err.code === 'REFERRAL_NOT_FOUND') return 404;
  if (err.code === 'REDEMPTION_EXPIRED') return 410;
  return 400;
}

// ── Member Resource ──

export const memberResource = defineResource({
  name: 'loyalty-member',
  displayName: 'Loyalty Members',
  tag: 'Loyalty',
  prefix: '/loyalty/members',
  disableDefaultRoutes: true,
  routes: [
    {
      method: 'POST',
      path: '/',
      summary: 'Enroll customer in loyalty program',
      permissions: permissions.customers.update,
      raw: true,
      schema: memberSchemas.enroll,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { customerId } = req.body as { customerId: string };
        try {
          const branchCode = await resolveBranchCode(req);
          const member = await bridge.enrollCustomer(customerId, { ...ctx(req), branchCode });
          return reply.code(201).send({ success: true, data: member });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'GET',
      path: '/:customerId',
      summary: 'Get loyalty member + balance',
      permissions: permissions.customers.get,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { customerId } = req.params as { customerId: string };
        try {
          const member = await bridge.getMemberForCustomer(customerId, ctx(req));
          if (!member) return reply.code(404).send({ success: false, message: 'Not enrolled' });
          const balance = {
            current: member.balance.current,
            lifetime: member.balance.lifetime,
            redeemed: member.balance.redeemed,
            expired: member.balance.expired,
            tier: member.tier,
            tierOverride: member.tierOverride,
          };
          return reply.send({ success: true, data: { member, balance } });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'POST',
      path: '/:customerId/deactivate',
      summary: 'Deactivate membership',
      permissions: permissions.customers.update,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { customerId } = req.params as { customerId: string };
        try {
          const member = await bridge.deactivateCustomerMembership(customerId, ctx(req));
          return reply.send({ success: true, data: member });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'POST',
      path: '/:customerId/reactivate',
      summary: 'Reactivate membership',
      permissions: permissions.customers.update,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { customerId } = req.params as { customerId: string };
        try {
          const member = await bridge.reactivateCustomerMembership(customerId, ctx(req));
          return reply.send({ success: true, data: member });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'POST',
      path: '/:customerId/adjust',
      summary: 'Adjust points (admin)',
      permissions: permissions.customers.update,
      raw: true,
      schema: memberSchemas.adjust,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { customerId } = req.params as { customerId: string };
        const { points, reason } = req.body as { points: number; reason: string };
        const reqCtx = ctx(req);
        try {
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
              organizationId: (reqCtx as { organizationId?: string }).organizationId,
            },
            'loyalty points adjusted',
          );
          return reply.send({ success: true, data: { transaction: tx, balanceAfter: tx.balanceAfter } });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'GET',
      path: '/:customerId/history',
      summary: 'Transaction history',
      permissions: permissions.customers.get,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { customerId } = req.params as { customerId: string };
        const { page = 1, limit = 20 } = req.query as { page?: number; limit?: number };
        try {
          const member = await bridge.requireMemberForCustomer(customerId, ctx(req));
          const data = await engine().repositories.pointTransaction.getAll({
            filters: { memberId: member._id },
            page: Number(page),
            limit: Math.min(Number(limit), 100),
            sort: { createdAt: -1 },
          });
          return reply.send({ success: true, data });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'POST',
      path: '/:customerId/tier-override',
      summary: 'Set tier override',
      permissions: permissions.loyalty.memberOps,
      raw: true,
      schema: memberSchemas.tierOverride,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { customerId } = req.params as { customerId: string };
        const { tier, reason } = req.body as { tier: string; reason: string };
        const reqCtx = ctx(req);
        try {
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
              organizationId: (reqCtx as { organizationId?: string }).organizationId,
            },
            'loyalty tier override set',
          );
          return reply.send({ success: true, data: updated });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'DELETE',
      path: '/:customerId/tier-override',
      summary: 'Clear tier override',
      permissions: permissions.loyalty.memberOps,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { customerId } = req.params as { customerId: string };
        const reqCtx = ctx(req);
        try {
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
              organizationId: (reqCtx as { organizationId?: string }).organizationId,
            },
            'loyalty tier override cleared',
          );
          return reply.send({ success: true, data: result });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'GET',
      path: '/:customerId/referrals',
      summary: 'Get member referrals',
      permissions: permissions.customers.get,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { customerId } = req.params as { customerId: string };
        const { page = 1, limit = 20 } = req.query as { page?: number; limit?: number };
        try {
          const member = await bridge.requireMemberForCustomer(customerId, ctx(req));
          const data = await engine().repositories.referral.getAll({
            filters: { referrerId: member._id },
            page: Number(page),
            limit: Math.min(Number(limit), 100),
          });
          return reply.send({ success: true, data });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
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
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const user = (req as any).user;
        const userId = user?._id || user?.id;
        if (!userId) return reply.code(401).send({ success: false, message: 'Authentication required' });
        try {
          let customer = await customerRepository.getByUserId(userId);
          if (!customer) customer = await customerRepository.linkOrCreateForUser(user);
          if (!customer)
            return reply.code(404).send({ success: false, message: 'Could not find or create customer profile' });
          const branchCode = await resolveBranchCode(req);
          const member = await bridge.enrollCustomer(customer._id as unknown as string, {
            actorId: userId,
            branchCode,
          });
          return reply.code(201).send({ success: true, data: member });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'GET',
      path: '/',
      summary: 'Get my loyalty status',
      permissions: permissions.customers.getMe,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const user = (req as any).user;
        const userId = user?._id || user?.id;
        if (!userId) return reply.code(401).send({ success: false, message: 'Authentication required' });
        try {
          const customer = await customerRepository.getByUserId(userId);
          if (!customer) return reply.code(404).send({ success: false, message: 'Customer profile not found' });
          const member = await bridge.getMemberForCustomer(customer._id as unknown as string, ctx(req));
          if (!member) return reply.send({ success: true, data: { enrolled: false } });
          const balance = {
            current: member.balance.current,
            lifetime: member.balance.lifetime,
            redeemed: member.balance.redeemed,
            expired: member.balance.expired,
            tier: member.tier,
            tierOverride: member.tierOverride,
          };
          return reply.send({ success: true, data: { enrolled: true, member, balance } });
        } catch (err: any) {
          return reply.code(400).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'POST',
      path: '/referral',
      summary: 'Apply a referral code (self-service)',
      permissions: permissions.customers.getMe,
      raw: true,
      schema: referralSchemas.selfRecord,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const user = (req as any).user;
        const userId = user?._id || user?.id;
        if (!userId) return reply.code(401).send({ success: false, message: 'Authentication required' });
        const { referralCode } = req.body as { referralCode: string };
        try {
          const customer = await customerRepository.getByUserId(userId);
          if (!customer) return reply.code(404).send({ success: false, message: 'Customer profile not found' });
          const referral = await engine().repositories.referral.recordReferral(
            { referralCode, refereeExternalId: customer._id as unknown as string, refereeExternalType: 'customer' },
            ctx(req),
          );
          return reply.code(201).send({ success: true, data: referral });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
  ],
});

// Earning Rules + Tiers moved to earning-rule.resource.ts / tier.resource.ts
// (modern adapter + actions pattern). They have vanilla CRUD shapes and don't
// belong in this wrapper file.

// ── Referrals Resource ──

export const referralResource = defineResource({
  name: 'loyalty-referral',
  displayName: 'Loyalty Referrals',
  tag: 'Loyalty',
  prefix: '/loyalty/referrals',
  disableDefaultRoutes: true,
  routes: [
    {
      method: 'POST',
      path: '/',
      summary: 'Record a referral',
      permissions: permissions.customers.update,
      raw: true,
      schema: referralSchemas.record,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { referralCode, refereeCustomerId } = req.body as { referralCode: string; refereeCustomerId: string };
        try {
          const referral = await engine().repositories.referral.recordReferral(
            { referralCode, refereeExternalId: refereeCustomerId, refereeExternalType: 'customer' },
            ctx(req),
          );
          return reply.code(201).send({ success: true, data: referral });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'POST',
      path: '/:referralId/approve',
      summary: 'Approve referral',
      permissions: permissions.loyalty.memberOps,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { referralId } = req.params as { referralId: string };
        const reqCtx = ctx(req);
        try {
          const referral = await engine().repositories.referral.approve(referralId, reqCtx);
          req.log.info(
            {
              audit: true,
              op: 'loyalty.referral.approve',
              referralId,
              actorId: reqCtx.actorId,
              organizationId: (reqCtx as { organizationId?: string }).organizationId,
            },
            'loyalty referral approved',
          );
          return reply.send({ success: true, data: referral });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'POST',
      path: '/:referralId/reject',
      summary: 'Reject referral',
      permissions: permissions.loyalty.memberOps,
      raw: true,
      schema: referralSchemas.reject,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { referralId } = req.params as { referralId: string };
        const { reason } = req.body as { reason: string };
        const reqCtx = ctx(req);
        try {
          const referral = await engine().repositories.referral.reject(referralId, reason, reqCtx);
          req.log.info(
            {
              audit: true,
              op: 'loyalty.referral.reject',
              referralId,
              reason,
              actorId: reqCtx.actorId,
              organizationId: (reqCtx as { organizationId?: string }).organizationId,
            },
            'loyalty referral rejected',
          );
          return reply.send({ success: true, data: referral });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'GET',
      path: '/lookup/:code',
      summary: 'Lookup referral code',
      permissions: permissions.customers.get,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { code } = req.params as { code: string };
        try {
          const member = await engine().repositories.referral.lookupByCode(code, ctx(req));
          if (!member) return reply.code(404).send({ success: false, message: 'Code not found' });
          return reply.send({ success: true, data: { referrerMemberId: member._id } });
        } catch (err: any) {
          return reply.code(400).send({ success: false, message: err.message });
        }
      },
    },
  ],
});
