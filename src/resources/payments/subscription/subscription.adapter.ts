import { createMongooseAdapter } from '@classytic/arc';
import { buildCrudSchemasFromModel } from '@classytic/mongokit';
import { subscriptionModel, subscriptionRepository } from './subscription.engine.js';

/**
 * FSM transitions are server-controlled — clients drive them through
 * `pause` / `resume` / `cancel` actions, never PATCH. Audit timestamps
 * are repo-stamped. The billing-cadence metadata (`nextBillingDate`,
 * `intervalDays`) is not stripped because it lives under `metadata` —
 * a `Mixed` field — and clients legitimately update it (e.g., admin
 * reschedules manually).
 */
const subscriptionSystemManagedFields = {
  organizationId: { systemManaged: true },
  publicId: { systemManaged: true },
  status: { systemManaged: true },
  isActive: { systemManaged: true },
  activatedAt: { systemManaged: true },
  pausedAt: { systemManaged: true },
  pauseReason: { systemManaged: true },
  canceledAt: { systemManaged: true },
  cancellationReason: { systemManaged: true },
  renewalCount: { systemManaged: true },
  renewalTransactionId: { systemManaged: true },
  transactionId: { systemManaged: true },
  paymentIntentId: { systemManaged: true },
};

export const subscriptionAdapter = createMongooseAdapter({
  model: subscriptionModel as never,
  repository: subscriptionRepository as never,
  schemaGenerator: (m, arcOptions) => {
    const forwardedRules =
      (arcOptions as { fieldRules?: Record<string, unknown> } | undefined)?.fieldRules ?? {};
    return buildCrudSchemasFromModel(m, {
      ...(arcOptions as Record<string, unknown>),
      fieldRules: { ...forwardedRules, ...subscriptionSystemManagedFields },
    } as Parameters<typeof buildCrudSchemasFromModel>[1]);
  },
});
