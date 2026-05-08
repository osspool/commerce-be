import type { FastifyRequest } from 'fastify';
import { getCrmContext } from '../context-helpers.js';
import { buildCrmServices } from '../crm-engine.js';

function resolveServices(req: FastifyRequest): ReturnType<typeof buildCrmServices> {
  if (typeof req.getCrmServices === 'function') return req.getCrmServices();
  return buildCrmServices(getCrmContext(req));
}

function actingUserId(req: FastifyRequest): string | undefined {
  const user = (req as unknown as { user?: { _id?: string; id?: string } }).user;
  return user?._id ?? user?.id;
}

export async function advanceOpportunity(
  id: string,
  data: Record<string, unknown>,
  req: FastifyRequest,
): Promise<unknown> {
  const services = resolveServices(req);
  if (!services) throw new Error('CRM engine is not enabled (set ENABLE_CRM=true)');
  const stageId = typeof data.stageId === 'string' ? data.stageId : '';
  if (!stageId) throw new Error("'stageId' is required");
  const by = actingUserId(req);
  const probability = typeof data.probability === 'number' ? data.probability : undefined;
  const note = typeof data.note === 'string' ? data.note : undefined;
  return services.opportunities.moveToStage(id, {
    stageId,
    ...(by ? { by } : {}),
    ...(probability !== undefined ? { probability } : {}),
    ...(note ? { note } : {}),
  });
}

export async function winOpportunity(id: string, data: Record<string, unknown>, req: FastifyRequest): Promise<unknown> {
  const services = resolveServices(req);
  if (!services) throw new Error('CRM engine is not enabled (set ENABLE_CRM=true)');
  const closedAt = typeof data.closedAt === 'string' ? new Date(data.closedAt) : undefined;
  const by = actingUserId(req);
  const note = typeof data.note === 'string' ? data.note : undefined;
  return services.opportunities.win(id, {
    ...(closedAt ? { closedAt } : {}),
    ...(by ? { by } : {}),
    ...(note ? { note } : {}),
  });
}

export async function loseOpportunity(
  id: string,
  data: Record<string, unknown>,
  req: FastifyRequest,
): Promise<unknown> {
  const services = resolveServices(req);
  if (!services) throw new Error('CRM engine is not enabled (set ENABLE_CRM=true)');
  const lostReasonId = typeof data.lostReasonId === 'string' ? data.lostReasonId : undefined;
  if (!lostReasonId) throw new Error("'lostReasonId' is required");
  const closedAt = typeof data.closedAt === 'string' ? new Date(data.closedAt) : undefined;
  const by = actingUserId(req);
  const note = typeof data.note === 'string' ? data.note : undefined;
  return services.opportunities.lose(id, {
    lostReasonId,
    ...(closedAt ? { closedAt } : {}),
    ...(by ? { by } : {}),
    ...(note ? { note } : {}),
  });
}

export async function abandonOpportunity(
  id: string,
  data: Record<string, unknown>,
  req: FastifyRequest,
): Promise<unknown> {
  const services = resolveServices(req);
  if (!services) throw new Error('CRM engine is not enabled (set ENABLE_CRM=true)');
  const note = typeof data.note === 'string' ? data.note : undefined;
  return services.opportunities.abandon(id, actingUserId(req), note);
}
