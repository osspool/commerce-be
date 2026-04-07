/**
 * Inventory Management Plugin — Engine init plugin — resources auto-discovered by loadResources()
 *
 * Initializes the Flow engine, event API, location bootstrap hook, and action routers.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { ActionRouterConfig } from '@classytic/arc/core';
import { createActionRouter } from '@classytic/arc/core';
import { inventoryActionRegistry } from './inventory.actions.js';

// Flow integration
import { initializeFlowEngine, setArcEventsApi } from './flow/index.js';
import { bootstrapLocationsForOrg } from './flow/location-bootstrap.js';
import { bootstrappedOrgs } from './inventory.jobs.js';

async function inventoryManagementPlugin(fastify: FastifyInstance): Promise<void> {
  // Initialize Flow engine
  initializeFlowEngine({
    connection: (fastify as unknown as { mongoose: { connection: import('mongoose').Connection } }).mongoose
      ?.connection,
  });

  if ((fastify as unknown as { events?: unknown }).events) {
    setArcEventsApi(
      (fastify as unknown as { events: { publish(event: string, data: unknown): Promise<void> } }).events,
    );
  }

  // Action routers (Stripe-style state transitions for transfer/purchase/request)
  for (const actionConfig of inventoryActionRegistry) {
    fastify.register(
      (instance, _opts, done) => {
        createActionRouter(instance, actionConfig as unknown as ActionRouterConfig);
        done();
      },
      { prefix: actionConfig.prefix },
    );
  }

  // Lazy-bootstrap default locations on first request per org
  fastify.addHook('onRequest', async (req: FastifyRequest) => {
    const user = req.user as { organizationId?: string } | undefined;
    const orgId = user?.organizationId;
    if (orgId && !bootstrappedOrgs.has(orgId)) {
      try {
        await bootstrapLocationsForOrg(orgId);
        bootstrappedOrgs.add(orgId);
      } catch {
        // Non-fatal — locations may already exist
      }
    }
  });
}

export default fp(inventoryManagementPlugin, {
  name: 'inventory-management',
  dependencies: ['register-core-plugins'],
});
