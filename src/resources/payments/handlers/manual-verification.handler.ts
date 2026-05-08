/**
 * Manual Payment Verification / Rejection Handlers
 *
 * Revenue v2 — calls domain verbs directly on the transaction repository.
 * Order bridge is wired via mongokit hook in revenue.plugin.ts.
 */

import { type OrderContext, repoOptionsFromCtx } from '@classytic/order';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ensureOrderEngine } from '#resources/sales/orders/order.engine.js';
import { getRevenueEngine } from '#shared/revenue/engine.js';
import { ConflictError, NotFoundError, UnauthorizedError, createError } from '@classytic/arc/utils';

interface VerifyManualPaymentBody {
  transactionId: string;
  notes?: string;
}

interface RejectManualPaymentBody {
  transactionId: string;
  reason: string;
}

function getUserId(request: FastifyRequest): string | null {
  const user = (request as unknown as { user?: { _id?: string; id?: string } }).user;
  return user?._id ?? user?.id ?? null;
}

export async function verifyManualPayment(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const { transactionId, notes } = request.body as VerifyManualPaymentBody;

  try {
    const verifiedBy = getUserId(request);
    if (!verifiedBy) {
      throw new UnauthorizedError('User authentication required for verification');
    }

    const repo = getRevenueEngine().repositories.transaction;
    const txn = await repo.verify(transactionId, { verifiedBy });

    request.log.info(
      { transactionId: String(txn._id), verifiedBy, amount: txn.amount, status: txn.status, notes },
      'OK: Manual payment verified',
    );

    return reply.code(200).send({
        transactionId: String(txn._id),
        publicId: txn.publicId,
        status: txn.status,
        amount: txn.amount,
        verifiedAt: txn.verifiedAt,
        verifiedBy: txn.verifiedBy,
        entity: txn.sourceModel && txn.sourceId ? { sourceModel: txn.sourceModel, sourceId: txn.sourceId } : null,
      });
  } catch (error: unknown) {
    const err = error as Error & { name?: string };
    const statusCode =
      err.name === 'TransactionNotFoundError' ? 404 : err.name === 'InvalidStateTransitionError' ? 409 : 500;

    request.log.error({ transactionId, err: err.message, statusCode }, 'ERROR: Manual verification failed');
    if (err.name === 'TransactionNotFoundError') throw new NotFoundError(err.message);
    if (err.name === 'InvalidStateTransitionError') throw new ConflictError(err.message);
    throw createError(statusCode, err.message);
  }
}

export async function rejectManualPayment(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const { transactionId, reason } = request.body as RejectManualPaymentBody;

  try {
    const rejectedBy = getUserId(request);
    if (!rejectedBy) {
      throw new UnauthorizedError('User authentication required for rejection');
    }

    const repo = getRevenueEngine().repositories.transaction;
    const txn = (await repo.getById(transactionId)) as Record<string, unknown> | null;
    if (!txn) {
      throw new NotFoundError('Transaction not found');
    }

    if (txn.status === 'verified') {
      throw new ConflictError('Cannot reject an already verified payment');
    }
    if (txn.status === 'failed') {
      throw new ConflictError('Payment already rejected');
    }

    await repo.update(transactionId, {
      status: 'failed',
      failureReason: reason,
      failedAt: new Date(),
    });

    if (txn.sourceModel === 'Order' && txn.sourceId) {
      try {
        const engine = await ensureOrderEngine();
        const ctx: OrderContext = {
          organizationId: String(txn.organizationId ?? ''),
          actorRef: rejectedBy,
          actorKind: 'user',
          correlationId: request.id ?? `webhook-${Date.now()}`,
        };
        const order = (await engine.repositories.order.getByQuery(
          { _id: txn.sourceId },
          repoOptionsFromCtx(ctx),
        )) as Record<string, unknown> | null;

        if (order?.orderNumber) {
          await engine.repositories.order.updatePaymentState(
            order.orderNumber as string,
            { chargeStatus: 'failed', failureReason: reason } as Record<string, unknown>,
            ctx,
          );
        }
      } catch (orderErr) {
        request.log.warn(
          { err: (orderErr as Error).message, transactionId },
          'Order payment-state update failed after rejection',
        );
      }
    }

    request.log.info({ transactionId, rejectedBy, reason }, 'OK: Manual payment rejected');
    return reply.code(200).send({
        transactionId,
        status: 'failed',
        failedAt: new Date(),
        failureReason: reason,
      });
  } catch (error: unknown) {
    const err = error as Error & { name?: string; statusCode?: number };
    // Re-throw Arc error subclasses directly — they already carry the correct
    // HTTP status and will be rendered by Arc's global error handler. Wrapping
    // them as createError(500, …) would lose the original status code.
    if (err.name === 'NotFoundError' || err.name === 'ConflictError' || err.name === 'UnauthorizedError') {
      throw error;
    }
    if (err.name === 'TransactionNotFoundError') throw new NotFoundError(err.message);
    if (err.name === 'InvalidStateTransitionError') throw new ConflictError(err.message);
    request.log.error({ transactionId, err: err.message }, 'ERROR: Manual rejection failed');
    throw createError(500, err.message);
  }
}
