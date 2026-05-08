import type { FastifyRequest } from 'fastify';
import { getCrmContext } from '../context-helpers.js';
import { buildCrmServices } from '../crm-engine.js';

function resolveServices(req: FastifyRequest): ReturnType<typeof buildCrmServices> {
  if (typeof req.getCrmServices === 'function') return req.getCrmServices();
  return buildCrmServices(getCrmContext(req));
}

export async function completeActivity(
  id: string,
  data: Record<string, unknown>,
  req: FastifyRequest,
): Promise<unknown> {
  const services = resolveServices(req);
  if (!services) throw new Error('CRM engine is not enabled (set ENABLE_CRM=true)');
  const completedAt = typeof data.completedAt === 'string' ? new Date(data.completedAt) : undefined;
  return services.activities.complete(id, completedAt);
}

export async function cancelActivity(id: string, data: Record<string, unknown>, req: FastifyRequest): Promise<unknown> {
  const services = resolveServices(req);
  if (!services) throw new Error('CRM engine is not enabled (set ENABLE_CRM=true)');
  const reason = typeof data.reason === 'string' ? data.reason : undefined;
  return services.activities.cancel(id, reason);
}
