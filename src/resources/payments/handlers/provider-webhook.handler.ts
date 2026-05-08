/**
 * Provider Webhook Handler — revenue v2
 *
 * Calls `repo.handleWebhook(provider, payload, headers)` directly.
 * Revenue v2's TransactionRepository validates, deduplicates, and
 * updates the transaction. Mongokit hooks fire on state change.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { getRevenueEngine } from '#shared/revenue/engine.js';
import { createError, NotFoundError, ValidationError } from '@classytic/arc/utils';

interface ProviderWebhookParams {
  provider: string;
}

export async function handleProviderWebhook(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const { provider } = request.params as ProviderWebhookParams;
  const payload = request.body as Record<string, unknown>;
  const headers = request.headers as Record<string, string>;

  try {
    const engine = getRevenueEngine();

    if (!engine.providers.has(provider)) {
      request.log.warn({ provider }, 'Webhook received for unregistered provider');
      throw new NotFoundError(`Provider '${provider}' not registered`);
    }

    const txn = await engine.repositories.transaction.handleWebhook(provider, payload, headers);

    if (!txn) {
      request.log.info({ provider }, 'Webhook received but no matching transaction found (ignored)');
      return reply.code(200).send(null);
    }

    request.log.info(
      {
        provider,
        transactionId: String(txn._id),
        publicId: txn.publicId,
        webhookType: txn.webhook?.eventType,
        status: txn.status,
      },
      'OK: Provider webhook processed',
    );

    return reply.code(200).send({
        event: txn.webhook?.eventType,
        eventId: txn.webhook?.eventId,
        transactionId: String(txn._id),
        publicId: txn.publicId,
        status: txn.status,
        provider,
      });
  } catch (error: unknown) {
    const err = error as Error & { name?: string; statusCode?: number };
    const statusCode = err.name === 'TransactionNotFoundError' ? 404 : err.name === 'ValidationError' ? 400 : 500;

    // Re-throw Arc error subclasses directly — they already carry the correct
    // HTTP status and will be rendered by Arc's global error handler.
    if (err.name === 'NotFoundError' || err.name === 'ValidationError' || err.name === 'ForbiddenError') {
      throw error;
    }

    request.log.error({ provider, err: err.message, statusCode }, 'ERROR: Webhook processing failed');

    if (err.name === 'AlreadyVerifiedError') {
      return reply.code(200).send(null);
    }

    if (err.name === 'TransactionNotFoundError') throw new NotFoundError(err.message);
    throw createError(statusCode, err.message);
  }
}
