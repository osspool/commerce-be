import type { FastifyRequest } from 'fastify';
import { getCrmContext } from '../context-helpers.js';
import { buildCrmServices } from '../crm-engine.js';

/**
 * Resolve CRM services for an incoming request. Prefers the
 * `req.getCrmServices()` decorator (set by `crm.plugin.ts`), falls back to
 * building services inline for test harnesses that instantiate the resource
 * without the plugin.
 */
function resolveServices(req: FastifyRequest): ReturnType<typeof buildCrmServices> {
  if (typeof req.getCrmServices === 'function') return req.getCrmServices();
  return buildCrmServices(getCrmContext(req));
}

function actingUserId(req: FastifyRequest): string | undefined {
  const user = (req as unknown as { user?: { _id?: string; id?: string } }).user;
  return user?._id ?? user?.id;
}

export async function qualifyLead(id: string, data: Record<string, unknown>, req: FastifyRequest): Promise<unknown> {
  const services = resolveServices(req);
  if (!services) throw new Error('CRM engine is not enabled (CRM_MODE=off)');
  const note = typeof data.note === 'string' ? data.note : undefined;
  return services.leads.qualify(id, actingUserId(req), note);
}

export async function disqualifyLead(id: string, data: Record<string, unknown>, req: FastifyRequest): Promise<unknown> {
  const services = resolveServices(req);
  if (!services) throw new Error('CRM engine is not enabled (CRM_MODE=off)');
  const reason = typeof data.reason === 'string' ? data.reason : 'unspecified';
  return services.leads.disqualify(id, reason, actingUserId(req));
}

export async function markLeadContacted(
  id: string,
  data: Record<string, unknown>,
  req: FastifyRequest,
): Promise<unknown> {
  const services = resolveServices(req);
  if (!services) throw new Error('CRM engine is not enabled (CRM_MODE=off)');
  const note = typeof data.note === 'string' ? data.note : undefined;
  return services.leads.markContacted(id, actingUserId(req), note);
}

export async function nurtureLead(id: string, _data: Record<string, unknown>, req: FastifyRequest): Promise<unknown> {
  const services = resolveServices(req);
  if (!services) throw new Error('CRM engine is not enabled (CRM_MODE=off)');
  return services.leads.nurture(id, actingUserId(req));
}

interface ConvertPayload {
  pipelineId?: unknown;
  opportunityName?: unknown;
  amount?: unknown;
  expectedCloseAt?: unknown;
}

export async function convertLead(id: string, data: Record<string, unknown>, req: FastifyRequest): Promise<unknown> {
  const services = resolveServices(req);
  if (!services) throw new Error('CRM engine is not enabled (CRM_MODE=off)');

  const { pipelineId, opportunityName, amount, expectedCloseAt } = data as ConvertPayload;
  if (typeof pipelineId !== 'string' || !pipelineId) {
    throw new Error("'pipelineId' is required to convert a lead");
  }

  const amountMoney =
    amount &&
    typeof amount === 'object' &&
    'amount' in amount &&
    'currency' in amount &&
    typeof (amount as { amount: unknown }).amount === 'number' &&
    typeof (amount as { currency: unknown }).currency === 'string'
      ? (amount as { amount: number; currency: string })
      : undefined;

  return services.leads.convert(id, {
    pipelineId,
    ...(typeof opportunityName === 'string' ? { opportunityName } : {}),
    ...(amountMoney ? { amount: amountMoney } : {}),
    ...(typeof expectedCloseAt === 'string' ? { expectedCloseAt: new Date(expectedCloseAt) } : {}),
    ...(actingUserId(req) ? { by: actingUserId(req) } : {}),
  });
}
