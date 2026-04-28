import type { RequestWithExtras } from '@classytic/arc/types';
import permissions from '#config/permissions.js';
import { getContextFromReq } from '#shared/context.js';
import { rfqRepository } from '../rfq.engine.js';
import {
  awardRfqSchema,
  cancelRfqSchema,
  submitResponseSchema,
} from '../schemas/rfq.schemas.js';

function rethrowKernelError(
  err: unknown,
  codeToStatus: Record<string, number>,
  fallbackMessage: string,
): never {
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

export const rfqActions = {
  send: {
    handler: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
      try {
        return await rfqRepository.send(id, getContextFromReq(req));
      } catch (err) {
        rethrowKernelError(
          err,
          {
            RFQ_NOT_FOUND: 404,
            RFQ_INVALID_TRANSITION: 422,
            RFQ_ALREADY_TERMINAL: 422,
          },
          'Cannot send RFQ',
        );
      }
    },
    permissions: permissions.orderActions.updateStatus,
  },

  submit_response: {
    handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
      try {
        const body = data as unknown as Parameters<typeof rfqRepository.submitResponse>[1];
        return await rfqRepository.submitResponse(id, body, getContextFromReq(req));
      } catch (err) {
        rethrowKernelError(
          err,
          {
            RFQ_NOT_FOUND: 404,
            RFQ_INVALID_TRANSITION: 422,
            RFQ_ALREADY_TERMINAL: 422,
            RFQ_VENDOR_NOT_INVITED: 403,
            RFQ_RESPONSE_TOTAL_MISMATCH: 400,
            RFQ_CONCURRENCY: 409,
          },
          'Cannot submit response',
        );
      }
    },
    schema: submitResponseSchema,
    // Vendor-portal endpoints would relax this — left as branch staff for
    // now since vendor auth isn't wired in this project.
    permissions: permissions.orderActions.updateStatus,
  },

  // Pure read — no write side effects, but kept as an action so the
  // ranking algorithm lives kernel-side and the HTTP shape stays
  // discoverable through the Stripe-style `/:id/action` endpoint.
  compare: {
    handler: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
      try {
        return await rfqRepository.compare(id, getContextFromReq(req));
      } catch (err) {
        rethrowKernelError(err, { RFQ_NOT_FOUND: 404 }, 'Cannot compare RFQ');
      }
    },
    permissions: permissions.orderActions.updateStatus,
  },

  award: {
    handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
      const vendorId = data.vendorId as string;
      const rationale = data.rationale as string | undefined;
      try {
        return await rfqRepository.award(
          id,
          vendorId,
          getContextFromReq(req),
          rationale ? { rationale } : undefined,
        );
      } catch (err) {
        rethrowKernelError(
          err,
          {
            RFQ_NOT_FOUND: 404,
            RFQ_INVALID_TRANSITION: 422,
            RFQ_ALREADY_TERMINAL: 422,
            RFQ_AWARD_WITHOUT_RESPONSE: 422,
            RFQ_CONCURRENCY: 409,
          },
          'Cannot award RFQ',
        );
      }
    },
    schema: awardRfqSchema,
    permissions: permissions.orderActions.updateStatus,
  },

  cancel: {
    handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
      try {
        return await rfqRepository.cancel(
          id,
          (data.reason as string) ?? 'cancelled',
          getContextFromReq(req),
        );
      } catch (err) {
        rethrowKernelError(
          err,
          {
            RFQ_NOT_FOUND: 404,
            RFQ_ALREADY_TERMINAL: 422,
          },
          'Cannot cancel RFQ',
        );
      }
    },
    schema: cancelRfqSchema,
    permissions: permissions.orderActions.updateStatus,
  },
};
