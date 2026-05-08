/**
 * RMA declarative actions — Stripe-style state transitions.
 *
 * Each action resolves the RMA by id (accepts _id or rmaNumber),
 * then delegates to the kernel's domain verb.
 *
 * FSM path:  requested → approved → received → inspected → resolved
 *                     ↘ rejected (terminal)
 *            requested → canceled (terminal)
 *
 * Multi-step flows: record_approval_decision walks the ApprovalChain;
 * once all steps reach consensus the FSM auto-transitions to
 * approved or rejected.
 */

import type { RequestWithExtras } from '@classytic/arc/types';
import { NotFoundError } from '@classytic/arc/utils';
import type { RmaDocument, RmaInspectInput, RmaResolveInput } from '@classytic/order';
import type {
  RmaApproveInput,
  RmaReceiveInput,
  RmaRejectInput,
} from '@classytic/order/schemas/rma';
import { Types } from 'mongoose';
import permissions from '#config/permissions.js';
import { getContextFromReq } from '#shared/context.js';
import type { AppEngineContext } from '#shared/context.js';
import { ensureRmaRepository } from '../rma.engine.js';

async function resolveRma(id: string, ctx: AppEngineContext): Promise<RmaDocument> {
  const repo = await ensureRmaRepository();
  const isOid = /^[a-f0-9]{24}$/i.test(id);
  const query = isOid ? { $or: [{ _id: id }, { rmaNumber: id }] } : { rmaNumber: id };
  const doc = await repo.getByQuery(query, { throwOnNotFound: false });
  if (!doc) throw new NotFoundError('RMA not found');
  return doc;
}

function rethrowKernelError(
  err: unknown,
  codeMap: Record<string, number>,
  fallback: string,
): never {
  const e = err as { code?: string; message?: string };
  const status = e?.code ? codeMap[e.code] : undefined;
  if (status) throw Object.assign(new Error(e.message ?? fallback), { statusCode: status, code: e.code });
  throw err;
}

const RMA_ERROR_MAP: Record<string, number> = {
  RMA_NOT_FOUND: 404,
  RMA_TERMINAL_STATE: 422,
  RMA_CONCURRENCY: 409,
  RMA_INSPECTION_MISSING_DISPOSITION: 400,
  RMA_RESOLUTION_MISSING: 400,
};

export const rmaActions = {
  approve: {
    handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
      const ctx = getContextFromReq(req);
      const doc = await resolveRma(id, ctx);
      try {
        return await (await ensureRmaRepository()).approve(
          doc.rmaNumber,
          data as RmaApproveInput,
          ctx,
        );
      } catch (err) {
        rethrowKernelError(err, RMA_ERROR_MAP, 'Cannot approve RMA');
      }
    },
    permissions: permissions.sales.returnManage,
  },

  reject: {
    handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
      const ctx = getContextFromReq(req);
      const doc = await resolveRma(id, ctx);
      if (typeof data.reason !== 'string' || !data.reason.trim()) {
        throw Object.assign(new Error('reason is required to reject an RMA'), { statusCode: 400 });
      }
      try {
        return await (await ensureRmaRepository()).reject(
          doc.rmaNumber,
          { reason: data.reason } as RmaRejectInput,
          ctx,
        );
      } catch (err) {
        rethrowKernelError(err, RMA_ERROR_MAP, 'Cannot reject RMA');
      }
    },
    permissions: permissions.sales.returnManage,
  },

  cancel: {
    handler: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
      const ctx = getContextFromReq(req);
      const doc = await resolveRma(id, ctx);
      try {
        return await (await ensureRmaRepository()).cancel(doc.rmaNumber, ctx);
      } catch (err) {
        rethrowKernelError(err, RMA_ERROR_MAP, 'Cannot cancel RMA');
      }
    },
    permissions: permissions.sales.returnCreate,
  },

  mark_received: {
    handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
      const ctx = getContextFromReq(req);
      const doc = await resolveRma(id, ctx);
      try {
        return await (await ensureRmaRepository()).markReceived(
          doc.rmaNumber,
          data as unknown as RmaReceiveInput,
          ctx,
        );
      } catch (err) {
        rethrowKernelError(err, RMA_ERROR_MAP, 'Cannot mark RMA as received');
      }
    },
    permissions: permissions.sales.returnInspect,
  },

  inspect: {
    handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
      const ctx = getContextFromReq(req);
      const doc = await resolveRma(id, ctx);
      try {
        return await (await ensureRmaRepository()).inspect(
          doc.rmaNumber,
          data as unknown as RmaInspectInput,
          ctx,
        );
      } catch (err) {
        rethrowKernelError(err, RMA_ERROR_MAP, 'Cannot inspect RMA');
      }
    },
    permissions: permissions.sales.returnInspect,
  },

  resolve: {
    handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
      const ctx = getContextFromReq(req);
      const doc = await resolveRma(id, ctx);
      try {
        const input: RmaResolveInput = {
          resolution: data.resolution as RmaResolveInput['resolution'],
          replacementOrderId: data.replacementOrderId
            ? new Types.ObjectId(data.replacementOrderId as string)
            : undefined,
          restockingFeePaisa: data.restockingFeePaisa as number | undefined,
        };
        return await (await ensureRmaRepository()).resolve(doc.rmaNumber, input, ctx);
      } catch (err) {
        rethrowKernelError(err, RMA_ERROR_MAP, 'Cannot resolve RMA');
      }
    },
    permissions: permissions.sales.returnManage,
  },

  record_approval_decision: {
    handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
      const ctx = getContextFromReq(req);
      const doc = await resolveRma(id, ctx);
      try {
        return await (await ensureRmaRepository()).recordApprovalDecision(
          doc.rmaNumber,
          data as never,
          ctx,
        );
      } catch (err) {
        rethrowKernelError(err, RMA_ERROR_MAP, 'Cannot record approval decision');
      }
    },
    permissions: permissions.sales.returnManage,
  },
};
