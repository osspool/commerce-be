import { repoOptionsFromCtx } from '@classytic/order';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getContextFromReq } from '#shared/context.js';
import { rfqRepository } from '../rfq.engine.js';
import { ValidationError } from '@classytic/arc/utils';

/**
 * Repo-driven create. Mongoose's auto-derived create body shape is too
 * strict for `lineItems` / `invitedVendors` arrays plus the optional
 * `validUntil` Date — the repo's create() does the actual validation
 * (line count > 0, vendor count > 0). Same justification as the blanket
 * + quotation resources.
 */
export async function createRfqHandler(req: FastifyRequest, reply: FastifyReply) {
  const ctx = getContextFromReq(req);
  const body = (req.body ?? {}) as Record<string, unknown>;

  // JSON serialization flattens Dates to ISO strings; RfqRepository.expireDue
  // and downstream comparisons want real Dates on the doc.
  const validUntil =
    typeof body.validUntil === 'string' ? new Date(body.validUntil) : (body.validUntil as Date | undefined);

  try {
    const rfq = await rfqRepository.create(
      {
        ...body,
        ...(validUntil ? { validUntil } : {}),
        organizationId: ctx.organizationId,
      },
      repoOptionsFromCtx(ctx),
    );
    reply.status(201).send(rfq);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e?.code === 'RFQ_MISSING_LINE_ITEMS' || e?.code === 'RFQ_MISSING_VENDORS') {
      throw new ValidationError(e.message ?? 'RFQ validation failed');
    }
    throw err;
  }
}
