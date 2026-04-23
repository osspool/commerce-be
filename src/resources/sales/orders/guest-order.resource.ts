/**
 * Guest Order Resource — public endpoints for anonymous storefront checkout.
 *
 * Carved out as a separate resource so resource-level rate limiting can be
 * conservative without throttling authenticated staff traffic on
 * `/orders/place`. No own model — this resource only forwards to the shared
 * placement pipeline after sanitising the body and upserting the customer.
 *
 * Feature-gated by `config.sales.guestCheckoutEnabled` (env GUEST_CHECKOUT,
 * default on). When disabled, the route returns 404 rather than 403 so
 * scanners can't fingerprint a feature-off deployment.
 */

import { defineResource } from '@classytic/arc';
import { allowPublic } from '@classytic/arc/permissions';
import type { OrderContext } from '@classytic/order';
import type { FastifyReply, FastifyRequest } from 'fastify';
import config from '#config/index.js';
import { getEcomBranchId } from './ecom-branch.js';
import {
  GuestCheckoutValidationError,
  sanitizeGuestBody,
  upsertGuestCustomer,
  validateGuestBody,
} from './guest-checkout.js';
import { executePlacement } from './placement.service.js';

const guestOrderResource = defineResource({
  name: 'guest-order',
  displayName: 'Guest Orders',
  tag: 'Orders',
  prefix: '/orders/guest',
  disableDefaultRoutes: true,

  // Conservative per-IP throttle — storefront card-testing + stock-probe
  // attacks are cheap to spin up. Staff /orders/place is on a different
  // resource, unaffected. Disabled in tests: integration suites hammer the
  // endpoint from one IP and would trip the limit on legitimate fixtures.
  rateLimit: process.env.NODE_ENV === 'test' ? false : { max: 10, timeWindow: '1 minute' },

  routes: [
    {
      method: 'POST',
      path: '/place',
      summary: 'Anonymous guest checkout — gated by GUEST_CHECKOUT env (default on)',
      permissions: allowPublic(),
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!config.sales.guestCheckoutEnabled) {
          return reply.status(404).send({ success: false, error: 'Not found' });
        }

        const sanitized = sanitizeGuestBody(req.body);
        let guestInput;
        try {
          guestInput = validateGuestBody(sanitized);
        } catch (err) {
          if (err instanceof GuestCheckoutValidationError) {
            return reply.status(400).send({
              success: false,
              error: err.message,
              ...(err.field ? { field: err.field } : {}),
            });
          }
          throw err;
        }

        const customer = await upsertGuestCustomer(guestInput);

        const ecomBranchId = await getEcomBranchId();
        const organizationId = ecomBranchId ?? (req.headers['x-organization-id'] as string) ?? '';
        const ctx: OrderContext = {
          organizationId,
          actorRef: `guest:${customer.id}`,
          actorKind: 'api',
          correlationId: req.id ?? '',
        };

        // Rehydrate the body with the upserted customer id so the order row
        // links back to the Customer record (same shape /orders/place uses).
        const pipelineBody = {
          ...sanitized,
          customer: {
            ...(sanitized.customer as Record<string, unknown>),
            id: customer.id,
            name: customer.name,
            phone: customer.phone,
            email: customer.email,
          },
        };

        const result = await executePlacement({
          body: pipelineBody,
          ctx,
          logger: req.log,
          forceChannel: 'web',
        });

        // Surface the customer id so the storefront can bind a local
        // "track my order" reference without requiring sign-in.
        if (result.status === 201 && result.body.success) {
          result.body.guestCustomerId = customer.id;
        }
        return reply.status(result.status).send(result.body);
      },
    },
  ],
});

export default guestOrderResource;
