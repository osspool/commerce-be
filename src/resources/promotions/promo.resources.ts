/**
 * Promo Resources — Programs, Vouchers, Evaluation
 *
 * Program & Voucher use Arc adapter for auto CRUD (list, get, create, update, delete).
 * State transitions use declarative `actions` (Stripe pattern).
 * Custom routes ONLY for sub-resources (rules, rewards) and composite views.
 * Evaluation is pure service orchestration — no model, disableDefaultRoutes.
 *
 * Raw routes go through `handleRaw` (Arc 2.9 utility) so each handler just
 * returns data — Arc owns the success envelope and respects `reply.sent` to
 * avoid double-write hazards. Domain errors from @classytic/promo are mapped
 * to ArcError instances with the right HTTP status code.
 *
 * ensurePromoEngine() is idempotent — safe to call at module top-level.
 * Same pattern as pricelist.resource.ts and order.resource.ts.
 */

import { createMongooseAdapter, defineResource } from '@classytic/arc';
import { ArcError, handleRaw } from '@classytic/arc/utils';
import type { EvaluateInput, GenerateCodesInput, GenerateSingleCodeInput } from '@classytic/promo';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import permissions from '#config/permissions.js';
import { ensurePromoEngine } from './promo.plugin.js';

// ── Top-level engine + adapter wiring ───────────────────────────────────────
// ensurePromoEngine() creates on first call, returns cached after.
// Mongoose is connected before loadResources() runs (Arc guarantee).

const promoEngine = ensurePromoEngine();

const programAdapter = createMongooseAdapter(promoEngine.models.Program as never, promoEngine.repositories.program as never);

const voucherAdapter = createMongooseAdapter(promoEngine.models.Voucher as never, promoEngine.repositories.voucher as never);

function engine() {
  return promoEngine;
}

/**
 * Company-wide context for promo service calls. `organizationId` is
 * intentionally omitted — promo is global across branches (see
 * [promo.plugin.ts](./promo.plugin.ts) and Arc's `tenantField: false`
 * on the program/voucher resources). Passing orgId here would make the
 * promo package's repos inject a per-branch filter on reads and stamp
 * it on writes, undoing the cross-branch design.
 */
function ctx(req: FastifyRequest) {
  const user = (req as unknown as Record<string, unknown>).user as Record<string, unknown> | undefined;
  const actorId = (user?._id || user?.id || 'anonymous') as string;
  return { actorId };
}

function statusForCode(code: string | undefined): number {
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
  if (code === 'CART_HASH_MISMATCH') return 409;
  if (code === 'TENANT_ISOLATION') return 403;
  return 400;
}

/**
 * Wrap a promo route so domain errors with `code` get mapped to the right
 * HTTP status. Anything that isn't already an ArcError is converted into one
 * so handleRaw's default error path produces a clean envelope.
 */
function promoRoute<T>(fn: (req: FastifyRequest, reply: FastifyReply) => Promise<T>, statusCode = 200) {
  return handleRaw<T>(async (req, reply) => {
    try {
      return await fn(req, reply);
    } catch (err) {
      if (err instanceof ArcError) throw err;
      const e = err as Error & { code?: string };
      throw new ArcError(e.message, {
        code: e.code ?? 'PROMO_ERROR',
        statusCode: statusForCode(e.code),
      });
    }
  }, statusCode);
}

/**
 * Same error-mapping as `promoRoute`, shaped for arc's declarative `actions:`
 * handlers (`(id, data, req) => Promise<unknown>`). arc's action router reads
 * `err.statusCode` + `err.code` on the thrown error — wrapping in `ArcError`
 * gives both, with the right HTTP code for promo's domain errors.
 */
function promoAction<T>(
  fn: (id: string, data: Record<string, unknown>, req: FastifyRequest) => Promise<T>,
) {
  return async (id: string, data: Record<string, unknown>, req: FastifyRequest): Promise<T> => {
    try {
      return await fn(id, data, req);
    } catch (err) {
      if (err instanceof ArcError) throw err;
      const e = err as Error & { code?: string; statusCode?: number };
      throw new ArcError(e.message, {
        code: e.code ?? 'PROMO_ERROR',
        statusCode: e.statusCode ?? statusForCode(e.code),
      });
    }
  };
}

// ── Program Resource ────────────────────────────────────────────────────────
// Arc auto-generates: GET /, GET /:id, POST /, PATCH /:id, DELETE /:id
// Actions: activate, pause, archive (Stripe pattern).
// Custom routes: composite view only. Rule/Reward CRUD lives at top-level
// `/promotions/rules` and `/promotions/rewards` — see rule.resource.ts and
// reward.resource.ts. Filter via `?programId=<id>` to scope to a program.

export const programResource = defineResource({
  name: 'promo-program',
  displayName: 'Promo Programs',
  tag: 'Promotions',
  prefix: '/promotions/programs',
  // Promo is company-wide (single-tenant multi-branch commerce): a Dhaka 10%
  // code must redeem at the Chittagong POS. `tenantField: false` opts out of
  // Arc's `AccessControl` org-scope filter; `organizationId` still lands on
  // each doc via promo's `injectTenantField` for audit/analytics.
  tenantField: false,
  adapter: programAdapter,
  permissions: {
    list: permissions.promotions.programs.list,
    get: permissions.promotions.programs.get,
    create: permissions.promotions.programs.create,
    update: permissions.promotions.programs.update,
    delete: permissions.promotions.programs.delete,
  },
  actions: {
    activate: {
      handler: async (id, _data, req) => engine().repositories.program.activate(id, ctx(req)),
      permissions: permissions.promotions.programs.transition,
    },
    pause: {
      handler: async (id, _data, req) => engine().repositories.program.pause(id, ctx(req)),
      permissions: permissions.promotions.programs.transition,
    },
    archive: {
      handler: async (id, _data, req) => engine().repositories.program.archive(id, ctx(req)),
      permissions: permissions.promotions.programs.transition,
    },
  },
  routes: [
    {
      method: 'GET',
      path: '/:id/full',
      summary: 'Get full program with rules + rewards',
      permissions: permissions.promotions.programs.get,
      raw: true,
      handler: promoRoute(async (req) => {
        const { id } = req.params as { id: string };
        const [program, rules, rewards] = await Promise.all([
          engine().repositories.program.getById(id, { lean: true }),
          engine().repositories.rule.findAll({ programId: id }),
          engine().repositories.reward.findAll({ programId: id }),
        ]);
        if (!program) {
          throw new ArcError('Program not found', { code: 'PROGRAM_NOT_FOUND', statusCode: 404 });
        }
        return { ...program, rules, rewards };
      }),
    },
  ],
});

// ── Voucher Resource ────────────────────────────────────────────────────────
// Arc auto-generates: GET /, GET /:id
// Actions: cancel (Stripe pattern → POST /:id/action { action: "cancel" }).
// Custom routes: generate, generate-single, validate-by-code, lookup-by-code
// — none fit Arc's id-scoped CRUD/action shape.

export const voucherResource = defineResource({
  name: 'promo-voucher',
  displayName: 'Promo Vouchers',
  tag: 'Promotions',
  prefix: '/promotions/vouchers',
  tenantField: false,
  adapter: voucherAdapter,
  permissions: {
    list: permissions.promotions.vouchers.list,
    get: permissions.promotions.vouchers.get,
  },
  actions: {
    cancel: {
      handler: promoAction(async (id, _data, req) =>
        engine().repositories.voucher.cancel(id, ctx(req)),
      ),
      permissions: permissions.promotions.vouchers.cancel,
    },
  },
  routes: [
    {
      method: 'POST',
      path: '/generate',
      summary: 'Generate batch voucher codes',
      permissions: permissions.promotions.vouchers.generate,
      raw: true,
      handler: promoRoute(
        async (req) => engine().services.voucher.generateCodes(req.body as GenerateCodesInput, ctx(req)),
        201,
      ),
    },
    {
      method: 'POST',
      path: '/generate-single',
      summary: 'Generate single voucher code',
      permissions: permissions.promotions.vouchers.generate,
      raw: true,
      handler: promoRoute(
        async (req) => engine().services.voucher.generateSingleCode(req.body as GenerateSingleCodeInput, ctx(req)),
        201,
      ),
    },
    {
      method: 'POST',
      path: '/validate/:code',
      summary: 'Validate voucher code',
      permissions: permissions.promotions.vouchers.get,
      raw: true,
      handler: promoRoute(async (req) => {
        const { code } = req.params as { code: string };
        return engine().services.voucher.validateCode(code, ctx(req));
      }),
    },
    {
      method: 'GET',
      path: '/code/:code',
      summary: 'Get voucher by code',
      permissions: permissions.promotions.vouchers.get,
      raw: true,
      handler: promoRoute(async (req) => {
        const { code } = req.params as { code: string };
        const data = await engine().repositories.voucher.getByCode(code);
        if (!data) {
          throw new ArcError('Voucher not found', { code: 'VOUCHER_NOT_FOUND', statusCode: 404 });
        }
        return data;
      }),
    },
  ],
});

// ── Evaluation Resource ─────────────────────────────────────────────────────
// No model, no adapter — pure service orchestration. Actions handle the
// id-scoped state transitions (commit, rollback); the two non-id-scoped
// routes (preview, evaluate-create) stay raw because Arc actions are
// always `:id`-bound.

export const evaluationResource = defineResource({
  name: 'promo-evaluation',
  displayName: 'Promo Evaluation',
  tag: 'Promotions',
  prefix: '/promotions/evaluate',
  disableDefaultRoutes: true,
  actions: {
    commit: {
      handler: promoAction(async (id, data, req) => {
        const { orderId, cartHash } = data as { orderId: string; cartHash?: string };
        // Forward `cartHash` when the client sends it — engine throws
        // CART_HASH_MISMATCH (→ 409) if the cart changed between evaluate
        // and commit. Classic tamper guard; see
        // packages/promo/src/services/evaluation.service.ts.
        return engine().services.evaluation.commit(id, orderId, ctx(req), cartHash ? { cartHash } : {});
      }),
      permissions: permissions.promotions.evaluation.evaluate,
      schema: z.object({
        orderId: z.string(),
        cartHash: z.string().optional(),
      }),
    },
    rollback: {
      handler: promoAction(async (id, _data, req) => {
        await engine().services.evaluation.rollback(id, ctx(req));
        return { message: 'Rolled back' };
      }),
      permissions: permissions.promotions.evaluation.evaluate,
    },
  },
  routes: [
    {
      method: 'POST',
      path: '/preview',
      summary: 'Preview evaluation (no side effects)',
      permissions: permissions.promotions.evaluation.preview,
      raw: true,
      handler: promoRoute(async (req) => engine().services.evaluation.preview(req.body as EvaluateInput, ctx(req))),
    },
    {
      method: 'POST',
      path: '/',
      summary: 'Evaluate cart (creates pending evaluation)',
      permissions: permissions.promotions.evaluation.evaluate,
      raw: true,
      handler: promoRoute(
        async (req) => engine().services.evaluation.evaluate(req.body as EvaluateInput, ctx(req)),
        201,
      ),
    },
  ],
});
