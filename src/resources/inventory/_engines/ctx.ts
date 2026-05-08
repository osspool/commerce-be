/**
 * Domain context builders for engine-backed resources.
 *
 * Extracts PurchaseContext / TransferContext from a Fastify request.
 * Mirrors the shape that @classytic/purchase and @classytic/transfer
 * expect on their repository method calls (actorId + currency).
 *
 * These helpers are intentionally thin — they do NOT call getFlowContext()
 * because purchase / transfer contexts are company-scoped documents, not
 * per-branch Flow scopes. branchId on PurchaseContext is optional and is
 * resolved by the engine's stockReceipt bridge from the document itself
 * (purchase.branch) at receive time.
 */

import type { FastifyRequest } from 'fastify';

// TODO: replace `Record<string, unknown>` with the real imported types after cp-dist
// import type { PurchaseContext } from '@classytic/purchase/domain';
// import type { TransferContext } from '@classytic/transfer/domain';
export type PurchaseContext = Record<string, unknown> & {
  actorId: string;
  currency: string;
};
export type TransferContext = Record<string, unknown> & {
  actorId: string;
  currency: string;
};

interface AuthUser {
  id?: string;
  _id?: string;
}

function resolveActorId(req: FastifyRequest): string {
  const user = (req as FastifyRequest & { user?: AuthUser }).user;
  return String(user?._id ?? user?.id ?? '');
}

/**
 * Build a PurchaseContext from a Fastify request.
 *
 * actorId  — stamped onto createdBy / approvedBy / receivedBy fields.
 * currency — always BDT for be-prod (single-currency deployment).
 */
export function buildPurchaseCtx(req: FastifyRequest): PurchaseContext {
  return {
    actorId: resolveActorId(req),
    currency: 'BDT',
  };
}

/**
 * Build a TransferContext from a Fastify request.
 *
 * actorId  — stamped onto statusHistory entries and approval fields.
 * currency — always BDT for be-prod.
 */
export function buildTransferCtx(req: FastifyRequest): TransferContext {
  return {
    actorId: resolveActorId(req),
    currency: 'BDT',
  };
}
