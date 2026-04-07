/**
 * Loyalty Resources — Members, Earning Rules, Tiers, Referrals
 *
 * Arc resources backed by @classytic/loyalty engine.
 * Follows warehouse.resources.ts convention: inline handlers, Zod schemas, no separate handler files.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { defineResource } from '@classytic/arc';
import type { CreateEarningRuleInput, CreateTierInput } from '@classytic/loyalty';
import permissions from '#config/permissions.js';
import { getLoyaltyEngine } from './loyalty.plugin.js';
import * as bridge from './loyalty.bridge.js';
import customerRepository from '../customers/customer.repository.js';
import Branch from '#resources/commerce/branch/branch.model.js';
import { memberSchemas, earningRuleSchemas, tierSchemas, referralSchemas } from './loyalty.schemas.js';

// ── Helpers (like flowCtx / flow in warehouse) ──

function engine() {
  return getLoyaltyEngine();
}

function ctx(req: FastifyRequest) {
  const user = (req as any).user;
  return { actorId: (user?._id || user?.id || 'anonymous') as string };
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
  additionalRoutes: [
    {
      method: 'POST',
      path: '/',
      summary: 'Enroll customer in loyalty program',
      permissions: permissions.customers.update,
      wrapHandler: false,
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
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { customerId } = req.params as { customerId: string };
        try {
          const member = await bridge.getMemberForCustomer(customerId, ctx(req));
          if (!member) return reply.code(404).send({ success: false, message: 'Not enrolled' });
          const balance = await engine().services.member.getBalance(member._id, ctx(req));
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
      wrapHandler: false,
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
      wrapHandler: false,
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
      wrapHandler: false,
      schema: memberSchemas.adjust,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { customerId } = req.params as { customerId: string };
        const { points, reason } = req.body as { points: number; reason: string };
        try {
          const member = await bridge.requireMemberForCustomer(customerId, ctx(req));
          const tx = await engine().services.ledger.adjustPoints(
            { memberId: member._id, points, description: reason, reason },
            ctx(req),
          );
          await bridge.syncCustomerMembership(customerId);
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
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { customerId } = req.params as { customerId: string };
        const { page = 1, limit = 20 } = req.query as { page?: number; limit?: number };
        try {
          const member = await bridge.requireMemberForCustomer(customerId, ctx(req));
          const data = await engine().services.ledger.getHistory(
            member._id,
            { page: Number(page), limit: Math.min(Number(limit), 100) },
            ctx(req),
          );
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
      permissions: permissions.loyalty.manage,
      wrapHandler: false,
      schema: memberSchemas.tierOverride,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { customerId } = req.params as { customerId: string };
        const { tier, reason } = req.body as { tier: string; reason: string };
        try {
          const member = await bridge.requireMemberForCustomer(customerId, ctx(req));
          const updated = await engine().services.tier.setOverride(member._id, tier, reason, ctx(req));
          await bridge.syncCustomerMembership(customerId);
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
      permissions: permissions.loyalty.manage,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { customerId } = req.params as { customerId: string };
        try {
          const member = await bridge.requireMemberForCustomer(customerId, ctx(req));
          const result = await engine().services.tier.clearOverride(member._id, ctx(req));
          await bridge.syncCustomerMembership(customerId);
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
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { customerId } = req.params as { customerId: string };
        const { page = 1, limit = 20 } = req.query as { page?: number; limit?: number };
        try {
          const member = await bridge.requireMemberForCustomer(customerId, ctx(req));
          const data = await engine().services.referral.getReferralsByReferrer(
            member._id,
            { page: Number(page), limit: Math.min(Number(limit), 100) },
            ctx(req),
          );
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
  additionalRoutes: [
    {
      method: 'POST',
      path: '/enroll',
      summary: 'Self-enroll in loyalty program',
      permissions: permissions.customers.getMe,
      wrapHandler: false,
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
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const user = (req as any).user;
        const userId = user?._id || user?.id;
        if (!userId) return reply.code(401).send({ success: false, message: 'Authentication required' });
        try {
          const customer = await customerRepository.getByUserId(userId);
          if (!customer) return reply.code(404).send({ success: false, message: 'Customer profile not found' });
          const member = await bridge.getMemberForCustomer(customer._id as unknown as string, ctx(req));
          if (!member) return reply.send({ success: true, data: { enrolled: false } });
          const balance = await engine().services.member.getBalance(member._id, ctx(req));
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
      wrapHandler: false,
      schema: referralSchemas.selfRecord,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const user = (req as any).user;
        const userId = user?._id || user?.id;
        if (!userId) return reply.code(401).send({ success: false, message: 'Authentication required' });
        const { referralCode } = req.body as { referralCode: string };
        try {
          const customer = await customerRepository.getByUserId(userId);
          if (!customer) return reply.code(404).send({ success: false, message: 'Customer profile not found' });
          const referral = await engine().services.referral.recordReferral(
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

// ── Earning Rules Resource ──

export const earningRuleResource = defineResource({
  name: 'loyalty-earning-rule',
  displayName: 'Earning Rules',
  tag: 'Loyalty',
  prefix: '/loyalty/earning-rules',
  disableDefaultRoutes: true,
  additionalRoutes: [
    {
      method: 'GET',
      path: '/',
      summary: 'List earning rules',
      permissions: permissions.loyalty.view,
      wrapHandler: false,
      schema: earningRuleSchemas.list,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { page = 1, limit = 50, status } = req.query as { page?: number; limit?: number; status?: string };
        try {
          const query: Record<string, unknown> = {};
          if (status) query.status = status;
          const data = await engine().services.earning.listRules(
            { ...query, page: Number(page), limit: Math.min(Number(limit), 100) },
            ctx(req),
          );
          return reply.send({ success: true, data });
        } catch (err: any) {
          return reply.code(400).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'GET',
      path: '/:ruleId',
      summary: 'Get earning rule',
      permissions: permissions.loyalty.view,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { ruleId } = req.params as { ruleId: string };
        try {
          const rule = await engine().repositories.earningRule.getById(ruleId);
          if (!rule) return reply.code(404).send({ success: false, message: 'Not found' });
          return reply.send({ success: true, data: rule });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'POST',
      path: '/',
      summary: 'Create earning rule',
      permissions: permissions.loyalty.manage,
      wrapHandler: false,
      schema: earningRuleSchemas.create,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        try {
          const rule = await engine().services.earning.createRule(req.body as CreateEarningRuleInput, ctx(req));
          return reply.code(201).send({ success: true, data: rule });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'PUT',
      path: '/:ruleId',
      summary: 'Update earning rule',
      permissions: permissions.loyalty.manage,
      wrapHandler: false,
      schema: earningRuleSchemas.update,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { ruleId } = req.params as { ruleId: string };
        try {
          const rule = await engine().services.earning.updateRule(
            ruleId,
            req.body as Record<string, unknown>,
            ctx(req),
          );
          return reply.send({ success: true, data: rule });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'POST',
      path: '/:ruleId/deactivate',
      summary: 'Deactivate earning rule',
      permissions: permissions.loyalty.manage,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { ruleId } = req.params as { ruleId: string };
        try {
          const rule = await engine().services.earning.deactivateRule(ruleId, ctx(req));
          return reply.send({ success: true, data: rule });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
  ],
});

// ── Tiers Resource ──

export const tierResource = defineResource({
  name: 'loyalty-tier',
  displayName: 'Loyalty Tiers',
  tag: 'Loyalty',
  prefix: '/loyalty/tiers',
  disableDefaultRoutes: true,
  additionalRoutes: [
    {
      method: 'GET',
      path: '/',
      summary: 'List tier definitions',
      permissions: permissions.loyalty.view,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        try {
          const tiers = await engine().services.tier.listTiers(ctx(req));
          return reply.send({ success: true, data: tiers });
        } catch (err: any) {
          return reply.code(400).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'POST',
      path: '/',
      summary: 'Create tier',
      permissions: permissions.loyalty.manage,
      wrapHandler: false,
      schema: tierSchemas.create,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        try {
          const tier = await engine().services.tier.createTier(req.body as CreateTierInput, ctx(req));
          return reply.code(201).send({ success: true, data: tier });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'PUT',
      path: '/:tierId',
      summary: 'Update tier',
      permissions: permissions.loyalty.manage,
      wrapHandler: false,
      schema: tierSchemas.update,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { tierId } = req.params as { tierId: string };
        try {
          const tier = await engine().services.tier.updateTier(tierId, req.body as Record<string, unknown>, ctx(req));
          return reply.send({ success: true, data: tier });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'DELETE',
      path: '/:tierId',
      summary: 'Delete tier',
      permissions: permissions.loyalty.manage,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { tierId } = req.params as { tierId: string };
        try {
          await engine().services.tier.deleteTier(tierId, ctx(req));
          return reply.send({ success: true, message: 'Tier deleted' });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'POST',
      path: '/evaluate',
      summary: 'Evaluate all members for tier changes',
      permissions: permissions.loyalty.manage,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        try {
          const result = await engine().services.tier.evaluateAll(ctx(req));
          return reply.send({ success: true, data: result });
        } catch (err: any) {
          return reply.code(400).send({ success: false, message: err.message });
        }
      },
    },
  ],
});

// ── Referrals Resource ──

export const referralResource = defineResource({
  name: 'loyalty-referral',
  displayName: 'Loyalty Referrals',
  tag: 'Loyalty',
  prefix: '/loyalty/referrals',
  disableDefaultRoutes: true,
  additionalRoutes: [
    {
      method: 'POST',
      path: '/',
      summary: 'Record a referral',
      permissions: permissions.customers.update,
      wrapHandler: false,
      schema: referralSchemas.record,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { referralCode, refereeCustomerId } = req.body as { referralCode: string; refereeCustomerId: string };
        try {
          const referral = await engine().services.referral.recordReferral(
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
      permissions: permissions.loyalty.manage,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { referralId } = req.params as { referralId: string };
        try {
          const referral = await engine().services.referral.approve(referralId, ctx(req));
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
      permissions: permissions.loyalty.manage,
      wrapHandler: false,
      schema: referralSchemas.reject,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { referralId } = req.params as { referralId: string };
        const { reason } = req.body as { reason: string };
        try {
          const referral = await engine().services.referral.reject(referralId, reason, ctx(req));
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
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { code } = req.params as { code: string };
        try {
          const member = await engine().services.referral.lookupByCode(code, ctx(req));
          if (!member) return reply.code(404).send({ success: false, message: 'Code not found' });
          return reply.send({ success: true, data: { referrerMemberId: member._id } });
        } catch (err: any) {
          return reply.code(400).send({ success: false, message: err.message });
        }
      },
    },
  ],
});
