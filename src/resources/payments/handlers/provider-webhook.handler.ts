/**
 * Provider Webhook Handler — revenue v2
 *
 * Calls `repo.handleWebhook(provider, payload, headers)` directly.
 * Revenue v2's TransactionRepository validates, deduplicates, and
 * updates the transaction. Mongokit hooks fire on state change.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { getRevenueEngine } from '#shared/revenue/engine.js';

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
      return reply.code(404).send({ success: false, message: `Provider '${provider}' not registered` });
    }

    const txn = await engine.repositories.transaction.handleWebhook(provider, payload, headers);

    if (!txn) {
      request.log.info({ provider }, 'Webhook received but no matching transaction found (ignored)');
      return reply.code(200).send({ success: true, message: 'No matching transaction' });
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
      success: true,
      message: 'Webhook processed successfully',
      data: {
        event: txn.webhook?.eventType,
        eventId: txn.webhook?.eventId,
        transactionId: String(txn._id),
        publicId: txn.publicId,
        status: txn.status,
        provider,
      },
    });
  } catch (error: unknown) {
    const err = error as Error & { name?: string };
    const statusCode = err.name === 'TransactionNotFoundError' ? 404 : err.name === 'ValidationError' ? 400 : 500;

    request.log.error({ provider, err: err.message, statusCode }, 'ERROR: Webhook processing failed');

    if (err.name === 'AlreadyVerifiedError') {
      return reply.code(200).send({ success: true, message: 'Webhook already processed' });
    }

    return reply.code(statusCode).send({ success: false, message: err.message, error: err.name });
  }
}
