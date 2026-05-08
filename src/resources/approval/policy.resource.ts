/**
 * Approval Policy Resource — admin matrix management.
 *
 * Auto-discovered by `loadResources()` (top-level `defineResource`).
 *
 * CRUD via the adapter. Plus one custom route:
 *   POST /preview — given a subjectType + evaluation context, returns the
 *   policy that would match (or null) and the resolved chain. Lets admins
 *   sanity-check "would PO at 150,000 BDT in branch X trigger CFO approval?"
 *   without creating a real PO.
 */

import { defineResource } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { buildCrudSchemasFromModel, QueryParser } from '@classytic/mongokit';
import type { RequestWithExtras } from '@classytic/arc/types';
import { getOrgId } from '@classytic/arc/scope';
import permissions from '#config/permissions.js';
import { requireAuth } from '#shared/permissions.js';
import { companyWide } from '#shared/presets/index.js';
import ApprovalPolicy from './policy.model.js';
import { approvalPolicyRepository } from './policy.repository.js';
import { createPolicyChainResolver } from './policy-resolver.js';
import { previewSchema } from './policy.schemas.js';

const queryParser = new QueryParser({
  maxLimit: 200,
  allowedFilterFields: ['subjectType', 'branchId', 'active'],
});

const systemManagedFields = ['version', 'createdBy', 'modifiedBy'];

const policyResource = defineResource({
  name: 'approval-policy',
  audit: true,
  displayName: 'Approval Policies',
  tag: 'Approval',
  prefix: '/approval/policies',

  adapter: createMongooseAdapter({
    model: ApprovalPolicy,
    repository: approvalPolicyRepository,
    schemaGenerator: (m, arcOptions) =>
      buildCrudSchemasFromModel(m, {
        ...(arcOptions as Record<string, unknown>),
        create: { omitFields: systemManagedFields },
        update: { omitFields: systemManagedFields },
      } as Parameters<typeof buildCrudSchemasFromModel>[1]),
  }),
  queryParser,

  // Policies are company-wide config — `branchId` is a *match selector*
  // on the policy doc itself, not a tenant scope. Use `companyWide` so the
  // CRUD pipeline doesn't filter by `organizationId` (we don't store one).
  presets: [companyWide],

  schemaOptions: {
    fieldRules: {
      version: { systemManaged: true },
      createdBy: { systemManaged: true },
      modifiedBy: { systemManaged: true },
    },
  },

  permissions: {
    list: requireAuth(),
    get: requireAuth(),
    create: permissions.approval.manage,
    update: permissions.approval.manage,
    delete: permissions.approval.manage,
  },

  // createdBy/modifiedBy stamping + version bumping are intentionally not
  // implemented here yet. Arc's audit trail records actor + diff per write,
  // which covers the immediate "who changed this policy" question. We can
  // add explicit stamping later via a controller override if FE needs it
  // surfaced as a top-level field.

  routes: [
    {
      method: 'POST',
      path: '/preview',
      summary: 'Preview which policy would match a given evaluation context',
      description:
        'Returns the policy the resolver would pick for the supplied (subjectType, evaluationContext) pair, plus the chain it would generate. Use to sanity-check thresholds before deploying or before submitting a real subject. Returns null + 200 when no policy matches.',
      permissions: requireAuth(),
      raw: true,
      schema: { body: previewSchema.body },
      handler: async (req: RequestWithExtras, reply: { send: (x: unknown) => unknown }) => {
        const orgId = getOrgId(req.scope);
        const body = (req.body ?? {}) as { subjectType: string; evaluationContext: Record<string, unknown> };

        const evalCtx = {
          ...body.evaluationContext,
          branchId: (body.evaluationContext.branchId as string | undefined) ?? orgId ?? '',
        };

        const resolve = createPolicyChainResolver();
        const result = await resolve(body.subjectType, evalCtx as { branchId: string });

        if (!result) {
          return reply.send({ matched: false, policyId: null, policyVersion: null, chain: null });
        }
        return reply.send({
          matched: true,
          policyId: result.policyId,
          policyVersion: result.policyVersion,
          chain: result.chain,
        });
      },
    },
  ],
});

export default policyResource;
