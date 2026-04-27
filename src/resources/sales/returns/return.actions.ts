/**
 * Return Action Registry — Stripe-style state transitions
 *
 * Wired via declarative `actions:` block → POST /sales/returns/:id/action
 * Body: { action: "approve" | "ship" | "receive" | "inspect" | "refund" | "reject" | "cancel", ... }
 */

import type { RequestWithExtras } from '@classytic/arc/types';
import permissions from '#config/permissions.js';
import { inspectActionSchema, reasonActionSchema, shipActionSchema } from './return.schemas.js';
import { returnService } from './return.service.js';

function actorId(req: RequestWithExtras): string {
  return (req.user?._id || req.user?.id || '') as string;
}

/**
 * Arc 2.8 declarative actions — imported by return.resource.ts. Action
 * schemas are Zod v4; Arc auto-converts at registration.
 */
export const returnActions = {
  approve: {
    handler: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
      return returnService.approveReturn(id, actorId(req));
    },
    permissions: permissions.sales.returnManage,
  },

  ship: {
    handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
      return returnService.markShipped(
        id,
        {
          provider: data.provider as string | undefined,
          trackingNumber: data.trackingNumber as string | undefined,
        },
        actorId(req),
      );
    },
    permissions: permissions.sales.returnManage,
    schema: shipActionSchema,
  },

  receive: {
    handler: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
      return returnService.receiveReturn(id, actorId(req));
    },
    permissions: permissions.sales.returnInspect,
  },

  inspect: {
    handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
      return returnService.inspectReturn(
        id,
        data.results as Array<{ productId: string; variantSku?: string; result: string; refundAmount?: number }>,
        actorId(req),
      );
    },
    permissions: permissions.sales.returnInspect,
    schema: inspectActionSchema,
  },

  refund: {
    handler: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
      return returnService.processRefund(id, actorId(req));
    },
    permissions: permissions.sales.returnManage,
  },

  reject: {
    handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
      return returnService.rejectReturn(id, (data.reason as string) || '', actorId(req));
    },
    permissions: permissions.sales.returnManage,
    schema: reasonActionSchema,
  },

  cancel: {
    handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
      return returnService.cancelReturn(id, (data.reason as string) || '', actorId(req));
    },
    permissions: permissions.sales.returnManage,
    schema: reasonActionSchema,
  },
};
