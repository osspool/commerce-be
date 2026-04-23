import { createBetterAuthAdapter } from '@classytic/arc/auth';
import type { CreateAppOptions, ResourceLike } from '@classytic/arc/factory';
import type { ErrorMapper } from '@classytic/arc/plugins';
import { createTenantKeyGenerator } from '@classytic/arc/scope';
import { defineErrorMapper } from '@classytic/arc/utils';
import { FlowError } from '@classytic/flow/domain';
import { InvalidTransitionError } from '@classytic/order';
import config from '#config/index.js';
import { getAppPreset } from '#core/app/get-app-preset.js';
import { registerAfterResources } from '#core/app/register-after-resources.js';
import { registerDomainBootstrap } from '#core/app/register-domain-bootstrap.js';
import { registerInfraPlugins } from '#core/app/register-infra-plugins.js';
import { eventTransport } from '#lib/events/EventBus.js';
import { getAuth } from '#resources/auth/auth.config.js';
import { eventRegistry } from '#shared/event-registry.js';

function getCorsAllowedHeaders(): string[] {
  return [
    ...new Set([
      ...(config.cors.allowedHeaders || ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept']),
      'x-organization-id',
      'x-arc-scope',
    ]),
  ];
}

/**
 * Map @classytic/flow domain errors to proper HTTP responses.
 * FlowError carries `.code` and `.httpStatus` — Arc's error handler uses
 * these instead of defaulting to 500. Registered once; covers all 33+
 * raw Flow-wrapper handlers in warehouse resources.
 */
// Arc 2.10.6 ships `defineErrorMapper<T>()` (@classytic/arc/utils) which
// handles the TS contravariance-widening for typed mappers registered in an
// `ErrorMapper[]` array — no more `as unknown as ErrorMapper` at call sites.
// Runtime dispatch is `instanceof`-based; each mapper only sees errors that
// match its `type`.
const flowErrorMapper = defineErrorMapper<FlowError>({
  type: FlowError,
  toResponse: (err) => ({
    status: err.httpStatus ?? 400,
    code: err.code ?? 'FLOW_ERROR',
    message: err.message,
  }),
});

// Order/Fulfillment FSM rejects invalid state transitions (e.g. `deliver`
// before `ship`, unknown action). These are client-caused — map to 422
// instead of letting them leak as 500.
const invalidTransitionMapper = defineErrorMapper<InvalidTransitionError>({
  type: InvalidTransitionError,
  toResponse: (err) => ({
    status: 422,
    code: err.code,
    message: err.message,
  }),
});

const flowErrorMappers: ErrorMapper[] = [flowErrorMapper, invalidTransitionMapper];

interface CreateArcAppOptionsInput {
  resources?: ResourceLike[];
}

export function createArcAppOptions({ resources }: CreateArcAppOptionsInput = {}): CreateAppOptions {
  return {
    preset: getAppPreset(),
    auth: {
      type: 'betterAuth',
      betterAuth: createBetterAuthAdapter({
        auth: getAuth(),
        orgContext: true,
      }),
    },
    cors: {
      ...config.cors,
      allowedHeaders: getCorsAllowedHeaders(),
    },
    // Disabled in dev/test — Next.js auth hooks refetch on every HMR and route
    // transition, exhausting the IP bucket in minutes. In prod, exempt auth
    // endpoints via Arc 2.10.6's `skipPaths`: pre-branch-selection calls like
    // /api/auth/get-session fall back to IP keying (no x-organization-id yet),
    // and one shared-NAT browser can starve every other user behind that IP.
    rateLimit:
      config.isDevelopment || config.isTest
        ? false
        : {
            max: config.rateLimit.max,
            timeWindow: `${config.rateLimit.windowMs}ms`,
            keyGenerator: createTenantKeyGenerator(),
            skipPaths: ['/api/auth/*'],
          },
    elevation: { platformRoles: ['superadmin'] },
    errorHandler: { errorMappers: flowErrorMappers },
    stores: { events: eventTransport },
    arcPlugins: {
      events: {
        logEvents: !config.isProduction,
        registry: eventRegistry,
        // `reject` in dev/staging/test forces emit sites to match the
        // registered Zod schemas (catches drift at PR time). `warn` in
        // production avoids crashing request traffic if a new emit path
        // slips past tests; the warning is actionable and tells ops to
        // deploy a fix. `off` would silently publish malformed events,
        // which defeats the purpose of registering schemas at all.
        validateMode: config.isProduction ? 'warn' : 'reject',
      },
      queryCache: true,
      metrics: true,
    },
    resourcePrefix: '/api/v1',
    resourceDir: resources ? undefined : 'src/resources',
    resources,
    plugins: registerInfraPlugins,
    bootstrap: [registerDomainBootstrap],
    afterResources: registerAfterResources,
  };
}
