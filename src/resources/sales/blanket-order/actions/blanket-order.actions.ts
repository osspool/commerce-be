import type { RequestWithExtras } from '@classytic/arc/types';
import permissions from '#config/permissions.js';
import { getContextFromReq } from '#shared/context.js';
import { blanketOrderRepository } from '../blanket-order.engine.js';
import { closeBlanketOrderSchema, extendBlanketOrderSchema } from '../schemas/blanket-order.schemas.js';

function rethrowKernelError(err: unknown, codeToStatus: Record<string, number>, fallbackMessage: string): never {
  const e = err as { code?: string; message?: string };
  const status = e?.code ? codeToStatus[e.code] : undefined;
  if (status) {
    throw Object.assign(new Error(e.message ?? fallbackMessage), {
      statusCode: status,
      code: e.code,
    });
  }
  throw err;
}

// Arc's `:id` URL param is the entity's `_id` (Mongo ObjectId), but the kernel's
// blanket-order methods (pause/resume/extend/cancel/generateOne) accept
// `blanketNumber` (e.g. "BLO-2026-0001"). Resolve _id → blanketNumber via
// the mongokit Repository so soft-delete / tenant / hooks / cache plugins
// fire — never via the raw Mongoose model. Per [packages/order/CLAUDE.md]
// non-negotiable rules: "Route through mongokit methods so hooks/cache/
// tenant plugins fire."
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
async function resolveBlanketNumber(
  id: string,
  ctx: { organizationId: string },
): Promise<string> {
  if (!OBJECT_ID_RE.test(id)) return id; // already a blanketNumber
  const doc = (await blanketOrderRepository.getById(id, {
    organizationId: ctx.organizationId,
    select: 'blanketNumber',
    lean: true,
    throwOnNotFound: false,
  })) as { blanketNumber?: string } | null;
  if (!doc?.blanketNumber) {
    throw Object.assign(new Error(`BlanketOrder ${id} not found`), {
      statusCode: 404,
      code: 'BLANKET_ORDER_NOT_FOUND',
    });
  }
  return doc.blanketNumber;
}

export const blanketOrderActions = {
  release_drawdown: {
    handler: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
      try {
        const ctx = getContextFromReq(req);
        const blanketNumber = await resolveBlanketNumber(id, ctx);
        return await blanketOrderRepository.generateOne(blanketNumber, { trigger: 'manual' }, ctx);
      } catch (err) {
        rethrowKernelError(
          err,
          {
            BLANKET_ORDER_NOT_FOUND: 404,
            BLANKET_ORDER_INVALID_TRANSITION: 422,
            BLANKET_ORDER_ALREADY_TERMINAL: 422,
          },
          'Cannot release drawdown',
        );
      }
    },
    permissions: permissions.orderActions.updateStatus,
  },

  close: {
    handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
      try {
        const ctx = getContextFromReq(req);
        const blanketNumber = await resolveBlanketNumber(id, ctx);
        return await blanketOrderRepository.cancel(blanketNumber, (data.reason as string) ?? 'closed', ctx);
      } catch (err) {
        rethrowKernelError(err, { BLANKET_ORDER_NOT_FOUND: 404, BLANKET_ORDER_ALREADY_TERMINAL: 422 }, 'Already terminal');
      }
    },
    schema: closeBlanketOrderSchema,
    permissions: permissions.orderActions.updateStatus,
  },

  extend: {
    handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
      try {
        const ctx = getContextFromReq(req);
        const blanketNumber = await resolveBlanketNumber(id, ctx);
        return await blanketOrderRepository.extend(blanketNumber, new Date(data.endAt as string), ctx);
      } catch (err) {
        rethrowKernelError(
          err,
          {
            BLANKET_ORDER_NOT_FOUND: 404,
            BLANKET_ORDER_ALREADY_TERMINAL: 422,
            BLANKET_ORDER_INVALID_EXTEND: 400,
            BLANKET_ORDER_CONCURRENCY: 409,
          },
          'Cannot extend blanket',
        );
      }
    },
    schema: extendBlanketOrderSchema,
    permissions: permissions.orderActions.updateStatus,
  },

  pause: {
    handler: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
      try {
        const ctx = getContextFromReq(req);
        const blanketNumber = await resolveBlanketNumber(id, ctx);
        return await blanketOrderRepository.pause(blanketNumber, ctx);
      } catch (err) {
        rethrowKernelError(err, { BLANKET_ORDER_NOT_FOUND: 404, BLANKET_ORDER_INVALID_TRANSITION: 422 }, 'Cannot pause');
      }
    },
    permissions: permissions.orderActions.updateStatus,
  },

  resume: {
    handler: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
      try {
        const ctx = getContextFromReq(req);
        const blanketNumber = await resolveBlanketNumber(id, ctx);
        return await blanketOrderRepository.resume(blanketNumber, ctx);
      } catch (err) {
        rethrowKernelError(err, { BLANKET_ORDER_NOT_FOUND: 404, BLANKET_ORDER_INVALID_TRANSITION: 422 }, 'Cannot resume');
      }
    },
    permissions: permissions.orderActions.updateStatus,
  },
};
