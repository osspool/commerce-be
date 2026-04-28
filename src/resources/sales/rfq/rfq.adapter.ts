import { createMongooseAdapter } from '@classytic/arc';
import { buildCrudSchemasFromModel } from '@classytic/mongokit';
import { rfqModel, rfqRepository } from './rfq.engine.js';

const rfqSystemManagedFields = {
  organizationId: { systemManaged: true },
  rfqNumber: { systemManaged: true },
  version: { systemManaged: true },
  actorRef: { systemManaged: true },
  actorKind: { systemManaged: true },
  status: { systemManaged: true },
  responses: { systemManaged: true },
  award: { systemManaged: true },
  generatedPoRef: { systemManaged: true },
  sentAt: { systemManaged: true },
  comparedAt: { systemManaged: true },
  awardedAt: { systemManaged: true },
  cancelledAt: { systemManaged: true },
  expiredAt: { systemManaged: true },
  cancellationReason: { systemManaged: true },
  // The line set + invitee list are immutable post-create; mutation goes
  // through actions, not PATCH.
  lineItems: { systemManaged: true },
  invitedVendors: { systemManaged: true },
};

export const rfqAdapter = createMongooseAdapter({
  model: rfqModel as never,
  repository: rfqRepository as never,
  schemaGenerator: (m, arcOptions) => {
    const forwardedRules =
      (arcOptions as { fieldRules?: Record<string, unknown> } | undefined)?.fieldRules ?? {};
    return buildCrudSchemasFromModel(m, {
      ...(arcOptions as Record<string, unknown>),
      fieldRules: { ...forwardedRules, ...rfqSystemManagedFields },
    } as Parameters<typeof buildCrudSchemasFromModel>[1]);
  },
});
