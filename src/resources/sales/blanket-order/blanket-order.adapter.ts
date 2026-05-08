import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { buildCrudSchemasFromModel } from '@classytic/mongokit';
import { blanketOrderModel, blanketOrderRepository } from './blanket-order.engine.js';

const blanketSystemManagedFields = {
  organizationId: { systemManaged: true },
  blanketNumber: { systemManaged: true },
  version: { systemManaged: true },
  actorRef: { systemManaged: true },
  actorKind: { systemManaged: true },
  currency: { systemManaged: true },
  status: { systemManaged: true },
  consumedQty: { systemManaged: true },
  generatedOrderCount: { systemManaged: true },
  generatedOrderRefs: { systemManaged: true },
  lastGeneratedAt: { systemManaged: true },
  nextDueAt: { systemManaged: true },
  pausedAt: { systemManaged: true },
  resumedAt: { systemManaged: true },
  exhaustedAt: { systemManaged: true },
  expiredAt: { systemManaged: true },
  cancelledAt: { systemManaged: true },
  cancellationReason: { systemManaged: true },
  cadence: { systemManaged: true },
  lineTemplate: { systemManaged: true },
};

export const blanketOrderAdapter = createMongooseAdapter({
  model: blanketOrderModel as never,
  repository: blanketOrderRepository as never,
  schemaGenerator: (model, arcOptions) => {
    const forwardedRules = (arcOptions as { fieldRules?: Record<string, unknown> } | undefined)?.fieldRules ?? {};
    return buildCrudSchemasFromModel(model, {
      ...(arcOptions as Record<string, unknown>),
      fieldRules: { ...forwardedRules, ...blanketSystemManagedFields },
    } as Parameters<typeof buildCrudSchemasFromModel>[1]);
  },
});
