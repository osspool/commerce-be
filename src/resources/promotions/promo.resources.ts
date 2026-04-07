/**
 * Promo Resources — Programs, Vouchers, Evaluation
 *
 * Arc resources backed by @classytic/promo engine.
 * Follows loyalty.resources.ts convention: inline handlers, no separate handler files.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { defineResource } from '@classytic/arc';
import type {
  CreateProgramInput,
  CreateRewardInput,
  GenerateCodesInput,
  GenerateSingleCodeInput,
  EvaluateInput,
  ListQuery,
} from '@classytic/promo';
import permissions from '#config/permissions.js';
import { getPromoEngine } from './promo.plugin.js';

// -- Helpers --

function engine() {
  return getPromoEngine();
}

function ctx(req: FastifyRequest) {
  const user = (req as any).user;
  return { actorId: (user?._id || user?.id || 'anonymous') as string };
}

function mapError(err: any): number {
  const code = err.code;
  if (
    code === 'PROGRAM_NOT_FOUND' ||
    code === 'VOUCHER_NOT_FOUND' ||
    code === 'EVALUATION_NOT_FOUND' ||
    code === 'RULE_NOT_FOUND' ||
    code === 'REWARD_NOT_FOUND'
  )
    return 404;
  if (code === 'INVALID_TRANSITION') return 422;
  if (code === 'VOUCHER_EXPIRED' || code === 'VOUCHER_EXHAUSTED') return 410;
  if (code === 'INSUFFICIENT_BALANCE' || code === 'VALIDATION_ERROR') return 400;
  if (code === 'DUPLICATE_REDEMPTION') return 409;
  if (code === 'TENANT_ISOLATION') return 403;
  return 400;
}

// -- Program Resource --

export const programResource = defineResource({
  name: 'promo-program',
  displayName: 'Promo Programs',
  tag: 'Promotions',
  prefix: '/promotions/programs',
  disableDefaultRoutes: true,
  additionalRoutes: [
    {
      method: 'GET',
      path: '/',
      summary: 'List programs',
      permissions: permissions.promotions.programs.list,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { page, limit, sort, ...filters } = req.query as Record<string, unknown>;
        try {
          const data = await engine().services.program.list(
            { page: page as number | undefined, limit: limit as number | undefined, sort: sort as string | undefined, filters } satisfies ListQuery,
            ctx(req),
          );
          return reply.send({ success: true, data });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'GET',
      path: '/:id',
      summary: 'Get program by ID',
      permissions: permissions.promotions.programs.get,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        try {
          const data = await engine().services.program.getById(id, ctx(req));
          return reply.send({ success: true, data });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'GET',
      path: '/:id/full',
      summary: 'Get full program with rules + rewards',
      permissions: permissions.promotions.programs.get,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        try {
          const data = await engine().services.program.getFullProgram(id, ctx(req));
          return reply.send({ success: true, data });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'POST',
      path: '/',
      summary: 'Create program',
      permissions: permissions.promotions.programs.create,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        try {
          const data = await engine().services.program.create(req.body as CreateProgramInput, ctx(req));
          return reply.code(201).send({ success: true, data });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'PUT',
      path: '/:id',
      summary: 'Update program',
      permissions: permissions.promotions.programs.update,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        try {
          const data = await engine().services.program.update(id, req.body as Record<string, unknown>, ctx(req));
          return reply.send({ success: true, data });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'POST',
      path: '/:id/action',
      summary: 'Transition program state (activate, pause, archive)',
      permissions: permissions.promotions.programs.transition,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const { action } = req.body as { action: 'activate' | 'pause' | 'archive' };
        try {
          let data: unknown;
          if (action === 'activate') {
            data = await engine().services.program.activate(id, ctx(req));
          } else if (action === 'pause') {
            data = await engine().services.program.pause(id, ctx(req));
          } else if (action === 'archive') {
            data = await engine().services.program.archive(id, ctx(req));
          } else {
            return reply.code(400).send({ success: false, message: `Unknown action: ${action}` });
          }
          return reply.send({ success: true, data });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'POST',
      path: '/:id/rules',
      summary: 'Add rule to program',
      permissions: permissions.promotions.programs.update,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        try {
          const data = await engine().services.program.addRule(id, req.body as Record<string, unknown>, ctx(req));
          return reply.code(201).send({ success: true, data });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'PUT',
      path: '/:id/rules/:ruleId',
      summary: 'Update rule',
      permissions: permissions.promotions.programs.update,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id, ruleId } = req.params as { id: string; ruleId: string };
        try {
          const data = await engine().services.program.updateRule(
            id,
            ruleId,
            req.body as Record<string, unknown>,
            ctx(req),
          );
          return reply.send({ success: true, data });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'DELETE',
      path: '/:id/rules/:ruleId',
      summary: 'Remove rule from program',
      permissions: permissions.promotions.programs.update,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id, ruleId } = req.params as { id: string; ruleId: string };
        try {
          await engine().services.program.removeRule(id, ruleId, ctx(req));
          return reply.send({ success: true, message: 'Rule removed' });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'POST',
      path: '/:id/rewards',
      summary: 'Add reward to program',
      permissions: permissions.promotions.programs.update,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        try {
          const data = await engine().services.program.addReward(id, req.body as CreateRewardInput, ctx(req));
          return reply.code(201).send({ success: true, data });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'PUT',
      path: '/:id/rewards/:rewardId',
      summary: 'Update reward',
      permissions: permissions.promotions.programs.update,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id, rewardId } = req.params as { id: string; rewardId: string };
        try {
          const data = await engine().services.program.updateReward(
            id,
            rewardId,
            req.body as Record<string, unknown>,
            ctx(req),
          );
          return reply.send({ success: true, data });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'DELETE',
      path: '/:id/rewards/:rewardId',
      summary: 'Remove reward from program',
      permissions: permissions.promotions.programs.update,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id, rewardId } = req.params as { id: string; rewardId: string };
        try {
          await engine().services.program.removeReward(id, rewardId, ctx(req));
          return reply.send({ success: true, message: 'Reward removed' });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
  ],
});

// -- Voucher Resource --

export const voucherResource = defineResource({
  name: 'promo-voucher',
  displayName: 'Promo Vouchers',
  tag: 'Promotions',
  prefix: '/promotions/vouchers',
  disableDefaultRoutes: true,
  additionalRoutes: [
    {
      method: 'POST',
      path: '/generate',
      summary: 'Generate batch voucher codes',
      permissions: permissions.promotions.vouchers.generate,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        try {
          const data = await engine().services.voucher.generateCodes(req.body as GenerateCodesInput, ctx(req));
          return reply.code(201).send({ success: true, data });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'POST',
      path: '/generate-single',
      summary: 'Generate single voucher code',
      permissions: permissions.promotions.vouchers.generate,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        try {
          const data = await engine().services.voucher.generateSingleCode(
            req.body as GenerateSingleCodeInput,
            ctx(req),
          );
          return reply.code(201).send({ success: true, data });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'POST',
      path: '/validate/:code',
      summary: 'Validate voucher code',
      permissions: permissions.promotions.vouchers.get,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { code } = req.params as { code: string };
        try {
          const data = await engine().services.voucher.validateCode(code, ctx(req));
          return reply.send({ success: true, data });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'GET',
      path: '/:id',
      summary: 'Get voucher by ID',
      permissions: permissions.promotions.vouchers.get,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        try {
          const data = await engine().services.voucher.getById(id, ctx(req));
          return reply.send({ success: true, data });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'GET',
      path: '/code/:code',
      summary: 'Get voucher by code',
      permissions: permissions.promotions.vouchers.get,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { code } = req.params as { code: string };
        try {
          const data = await engine().services.voucher.getByCode(code, ctx(req));
          return reply.send({ success: true, data });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'POST',
      path: '/:id/cancel',
      summary: 'Cancel voucher',
      permissions: permissions.promotions.vouchers.cancel,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        try {
          const data = await engine().services.voucher.cancel(id, ctx(req));
          return reply.send({ success: true, data });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
  ],
});

// -- Evaluation Resource --

export const evaluationResource = defineResource({
  name: 'promo-evaluation',
  displayName: 'Promo Evaluation',
  tag: 'Promotions',
  prefix: '/promotions/evaluate',
  disableDefaultRoutes: true,
  additionalRoutes: [
    {
      method: 'POST',
      path: '/preview',
      summary: 'Preview evaluation (no side effects)',
      permissions: permissions.promotions.evaluation.preview,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        try {
          const data = await engine().services.evaluation.preview(req.body as EvaluateInput, ctx(req));
          return reply.send({ success: true, data });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'POST',
      path: '/',
      summary: 'Evaluate cart (creates pending evaluation)',
      permissions: permissions.promotions.evaluation.evaluate,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        try {
          const data = await engine().services.evaluation.evaluate(req.body as EvaluateInput, ctx(req));
          return reply.code(201).send({ success: true, data });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'POST',
      path: '/:evaluationId/commit',
      summary: 'Commit evaluation to order',
      permissions: permissions.promotions.evaluation.evaluate,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { evaluationId } = req.params as { evaluationId: string };
        const { orderId } = req.body as { orderId: string };
        try {
          const data = await engine().services.evaluation.commit(evaluationId, orderId, ctx(req));
          return reply.send({ success: true, data });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
    {
      method: 'POST',
      path: '/:evaluationId/rollback',
      summary: 'Rollback evaluation',
      permissions: permissions.promotions.evaluation.evaluate,
      wrapHandler: false,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { evaluationId } = req.params as { evaluationId: string };
        try {
          const data = await engine().services.evaluation.rollback(evaluationId, ctx(req));
          return reply.send({ success: true, data });
        } catch (err: any) {
          return reply.code(mapError(err)).send({ success: false, message: err.message });
        }
      },
    },
  ],
});
