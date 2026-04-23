/**
 * CRM plugin — gated on `CRM_MODE`.
 *
 * When `config.crm.mode !== 'off'`, this plugin:
 *   1. Decorates the Fastify request with a `getCrmServices()` accessor that
 *      lazily constructs the per-request CRM service bundle when called.
 *   2. Registers CRM → commerce event bridges on Arc's event transport (so a
 *      `crm:opportunity.won` flips the related Customer's CRM stage).
 *
 * When mode is 'off' nothing is wired — zero overhead, matching the Flow
 * progressive-module pattern.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import config from '#config/index.js';
import { eventTransport } from '#lib/events/EventBus.js';
import { getCrmContext } from './context-helpers.js';
import { registerCrmEventBridges } from './crm.events.js';
import { buildCrmServices, type CrmServices } from './crm-engine.js';

declare module 'fastify' {
  interface FastifyRequest {
    getCrmServices?: () => CrmServices | null;
  }
}

export default async function crmPlugin(fastify: FastifyInstance): Promise<void> {
  if (config.crm.mode === 'off') {
    fastify.log.info({ mode: 'off' }, 'CRM engine disabled (set CRM_MODE=simple|standard to enable)');
    return;
  }

  await registerCrmEventBridges(eventTransport);

  fastify.decorateRequest('getCrmServices', function (this: FastifyRequest) {
    const ctx = getCrmContext(this);
    return buildCrmServices(ctx);
  });

  fastify.log.info({ mode: config.crm.mode }, 'CRM engine wired');
}
