import { getRevenue } from '#shared/revenue/revenue.plugin.js';

import type { FastifyRequest, FastifyReply } from 'fastify';

interface ProviderWebhookParams {
  provider: string;
}

/**
 * Provider Webhook Handler
 * Handles automatic webhooks from payment providers (Stripe, SSLCommerz, bKash, Nagad)
 *
 * Flow:
 * 1. Provider sends webhook POST to /webhooks/payments/:provider
 * 2. Library validates webhook signature (provider-specific)
 * 3. Library parses webhook event data
 * 4. Library finds transaction by paymentIntentId
 * 5. Library updates transaction status based on event
 * 6. Library triggers 'payment.webhook.{eventType}' hook
 * 7. Hook updates entity (Order/Enrollment/Subscription)
 *
 * Supported Events:
 * - payment.succeeded -> Activates entity
 * - payment.failed -> Logs failure
 * - refund.succeeded -> Updates transaction to refunded
 */
export async function handleProviderWebhook(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const { provider } = request.params as ProviderWebhookParams;
  const payload = request.body as Record<string, unknown>;
  const headers = request.headers;

  try {
    const revenue = getRevenue();

    // Validate provider is registered
    const registeredProviders: string[] = Object.keys(revenue.providers);
    if (!registeredProviders.includes(provider)) {
      request.log.warn(
        {
          provider,
          registeredProviders,
        },
        'Webhook received for unregistered provider',
      );

      return reply.code(404).send({
        success: false,
        message: `Provider '${provider}' not registered`,
        registeredProviders,
      });
    }

    // Handle webhook via revenue service (validates signature, parses event, updates transaction)
    const result = (await (revenue as any).payments.handleWebhook(provider, payload, headers)) as any;

    // Extract entity info if available
    const entityInfo =
      result.transaction?.sourceModel && result.transaction?.sourceId
        ? {
            sourceModel: result.transaction.sourceModel,
            sourceId: result.transaction.sourceId.toString(),
          }
        : null;

    // Log success with full context
    request.log.info(
      {
        provider,
        eventType: result.event?.type,
        eventId: result.event?.id,
        transactionId: result.transaction?._id?.toString(),
        amount: result.transaction?.amount,
        category: result.transaction?.category,
        status: result.status,
        entity: entityInfo,
      },
      'OK: Provider webhook processed',
    );

    // Return 200 to acknowledge webhook receipt
    return reply.code(200).send({
      success: true,
      message: 'Webhook processed successfully',
      data: {
        event: result.event?.type,
        eventId: result.event?.id,
        transactionId: result.transaction?._id?.toString(),
        status: result.status,
        provider,
      },
    });
  } catch (error: unknown) {
    const err = error as Error & { name: string };
    // Map error types to HTTP status codes
    const statusCode =
      err.name === 'ProviderNotFoundError'
        ? 404
        : err.name === 'TransactionNotFoundError'
          ? 404
          : err.name === 'ValidationError'
            ? 400
            : err.name === 'ProviderError'
              ? 400
              : 500;

    // Log error with full context (helps debugging webhook issues)
    request.log.error(
      {
        provider,
        errorName: err.name,
        errorMessage: err.message,
        stack: err.stack,
        statusCode,
        payloadKeys: Object.keys(payload || {}),
        headers: {
          'content-type': headers['content-type'],
          'user-agent': headers['user-agent'],
        },
      },
      'ERROR: Webhook processing failed',
    );

    // Still return 200 for already_processed (idempotency)
    if (err.name === 'AlreadyVerifiedError' || (statusCode as number) === 409) {
      return reply.code(200).send({
        success: true,
        message: 'Webhook already processed',
        error: err.name,
      });
    }

    return reply.code(statusCode).send({
      success: false,
      message: err.message,
      error: err.name,
    });
  }
}
