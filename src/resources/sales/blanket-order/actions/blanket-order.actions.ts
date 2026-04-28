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

export const blanketOrderActions = {
  release_drawdown: {
    handler: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
      try {
        return await blanketOrderRepository.generateOne(id, { trigger: 'manual' }, getContextFromReq(req));
      } catch (err) {
        rethrowKernelError(
          err,
          {
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
        return await blanketOrderRepository.cancel(id, (data.reason as string) ?? 'closed', getContextFromReq(req));
      } catch (err) {
        rethrowKernelError(err, { BLANKET_ORDER_ALREADY_TERMINAL: 422 }, 'Already terminal');
      }
    },
    schema: closeBlanketOrderSchema,
    permissions: permissions.orderActions.updateStatus,
  },

  extend: {
    handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
      try {
        return await blanketOrderRepository.extend(id, new Date(data.endAt as string), getContextFromReq(req));
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
      return blanketOrderRepository.pause(id, getContextFromReq(req));
    },
    permissions: permissions.orderActions.updateStatus,
  },

  resume: {
    handler: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
      return blanketOrderRepository.resume(id, getContextFromReq(req));
    },
    permissions: permissions.orderActions.updateStatus,
  },
};
