/**
 * Branch off-boarding — HQ-admin purge of a closing branch's WMS data.
 *
 * Wraps `flow.purgeBranch(branchId)` — a chunked hard-purge of every
 * org-scoped Flow collection for the target branch (stock, lots, moves,
 * reservations, locations, …). The append-only event ledger is retained
 * (its lifecycle is host TTL / archival). Head-office-only, irreversible,
 * and confirm-token guarded.
 */
import { defineResource } from '@classytic/arc';
import { NotFoundError, ValidationError } from '@classytic/arc/utils';
import type { FastifyReply, FastifyRequest } from 'fastify';
import mongoose from 'mongoose';
import { z } from 'zod';
import { getFlowEngine } from '#resources/inventory/flow/flow-engine.js';
import { requireHeadOfficeAdmin } from '#shared/permissions.js';

const purgeBodySchema = z.object({
  /** Must echo the target branchId — a deliberate brake on an irreversible op. */
  confirm: z.string().min(1),
  strategy: z.enum(['hard', 'soft']).optional(),
  batchSize: z.number().int().positive().max(10_000).optional(),
});

const branchOffboardingResource = defineResource({
  name: 'branch-offboarding',
  displayName: 'Branch Off-boarding',
  tag: 'Inventory',
  prefix: '/inventory/admin',
  disableDefaultRoutes: true,
  routes: [
    {
      method: 'POST',
      path: '/branches/:branchId/purge',
      summary: 'Purge ALL WMS data for a closing branch (irreversible)',
      description:
        'Head-office-only. Chunked hard-purge of every org-scoped Flow ' +
        'collection for the target branch. The append-only event ledger is ' +
        'retained. Body must echo the target branchId as `confirm`.',
      permissions: requireHeadOfficeAdmin,
      raw: true,
      tags: ['Inventory - Admin'],
      handler: async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
        const { branchId } = req.params as { branchId: string };
        const body = purgeBodySchema.parse(req.body ?? {});

        if (!mongoose.isValidObjectId(branchId)) {
          throw new ValidationError('branchId must be a valid organization id.');
        }
        if (body.confirm !== branchId) {
          throw new ValidationError('Confirmation mismatch: `confirm` must equal the target branchId.');
        }

        // Refuse to off-board the head-office branch — purging HQ would wipe
        // the canonical/default warehouse. Branch role lives under `branchRole`
        // (denormalised) or `role` on the organization doc (AGENTS.md).
        const orgDoc = await mongoose.connection
          .collection('organization')
          .findOne({ _id: new mongoose.Types.ObjectId(branchId) }, { projection: { branchRole: 1, role: 1 } });
        if (!orgDoc) throw new NotFoundError('Branch');
        const branchRole = (orgDoc.branchRole as string | undefined) ?? (orgDoc.role as string | undefined);
        if (branchRole === 'head_office') {
          throw new ValidationError('Refusing to off-board the head-office branch.');
        }

        const flow = getFlowEngine();
        const result = await flow.purgeBranch(branchId, {
          ...(body.strategy ? { strategy: body.strategy } : {}),
          ...(body.batchSize ? { batchSize: body.batchSize } : {}),
        });

        // Loud audit line — irreversible data removal.
        req.log?.warn({ branchId, result }, 'branch off-boarding purge executed');

        return reply.send(result);
      },
    },
  ],
});

export default branchOffboardingResource;
