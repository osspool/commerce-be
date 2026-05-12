import { createBetterAuthAdapter } from "@classytic/arc/auth";
import { loadResources } from "@classytic/arc/factory";
import type { CreateAppOptions, ResourceLike } from "@classytic/arc/factory";
import type { ErrorMapper } from "@classytic/arc/plugins";
import { createTenantKeyGenerator } from "@classytic/arc/scope";
import { defineErrorMapper } from "@classytic/arc/utils";
import { FlowError } from "@classytic/flow/domain";
import { AccountingError } from "@classytic/ledger";
import { IllegalTransitionError } from "@classytic/primitives/state-machine";
import config from "#config/index.js";
import { getEnabledResourceDirs } from "#config/resource-manifest.js";
import type { AppContext } from "#core/app/context.js";
import { getAppPreset } from "#core/app/get-app-preset.js";
import { registerAfterResources } from "#core/app/register-after-resources.js";
import { registerDomainBootstrap } from "#core/app/register-domain-bootstrap.js";
import { registerInfraPlugins } from "#core/app/register-infra-plugins.js";
import { eventTransport } from "#lib/events/EventBus.js";
import { getAuth } from "#resources/auth/auth.config.js";
import { ensureCatalogEngine } from "#resources/catalog/catalog.engine.js";
import { eventRegistry } from "#shared/event-registry.js";

function getCorsAllowedHeaders(): string[] {
  return [
    ...new Set([
      ...(config.cors.allowedHeaders || [
        "Content-Type",
        "Authorization",
        "X-Requested-With",
        "Accept",
      ]),
      "x-organization-id",
      "x-arc-scope",
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
    code: err.code ?? "FLOW_ERROR",
    message: err.message,
  }),
});

// Order / Fulfillment / any FSM-bearing aggregate (Flow's StockMove,
// ProcurementOrder, return, scrap, wave …) throws this when a status
// transition isn't allowed (e.g. `deliver` before `ship`, unknown action).
// Client-caused → map to 422 instead of letting it leak as 500. The error
// type is canonical via `@classytic/primitives/state-machine` — every
// kernel that uses `defineStateMachine` throws this same class, so one
// mapper covers the whole stack.
const invalidTransitionMapper = defineErrorMapper<IllegalTransitionError>({
  type: IllegalTransitionError,
  toResponse: (err) => ({
    status: 422,
    code: err.code,
    message: err.message,
  }),
});

// `@classytic/ledger`'s `AccountingError` carries `.status` (HTTP) and
// `.code` (domain — e.g. `PERIOD_LOCKED_DAILY`, `IMMUTABLE_ENTRY`,
// `CREDIT_LIMIT_EXCEEDED`). Without this mapper, arc 2.13's error handler
// drops `.code` and emits `arc.<status>` (`arc.conflict`), erasing the
// finance-domain semantic that clients (and tests) discriminate on.
const accountingErrorMapper = defineErrorMapper<AccountingError>({
  type: AccountingError,
  toResponse: (err) => ({
    status: err.status ?? 400,
    code: err.code ?? 'ACCOUNTING_ERROR',
    message: err.message,
    ...(err.fields ? { details: err.fields as never } : {}),
  }),
});

const flowErrorMappers: ErrorMapper[] = [
  flowErrorMapper,
  invalidTransitionMapper,
  accountingErrorMapper,
];

interface CreateArcAppOptionsInput {
  resources?: ResourceLike[];
}

export function createArcAppOptions({
  resources,
}: CreateArcAppOptionsInput = {}): CreateAppOptions {
  return {
    preset: getAppPreset(),
    auth: {
      type: "betterAuth",
      betterAuth: createBetterAuthAdapter({
        auth: getAuth(),
        orgContext: true,
      }),
    },
    cors: {
      ...config.cors,
      allowedHeaders: getCorsAllowedHeaders(),
    },
    // Cap multipart uploads (CSV import, image upload). Hosts hitting the
    // limit get a 413 before the route handler runs. JSON body limit stays
    // at Fastify's default — Arc 2.14 doesn't surface that knob and 1 MiB
    // is adequate for commerce JSON traffic.
    multipart: {
      limits: {
        fileSize: config.httpLimits.multipartFileSize,
        files: config.httpLimits.multipartFiles,
      },
    },
    // Disabled in dev/test — Next.js auth hooks refetch on every HMR and route
    // transition, exhausting the IP bucket in minutes. In prod, exempt auth
    // endpoints via Arc 2.10.6's `skipPaths`: pre-branch-selection calls like
    // /api/auth/get-session fall back to IP keying (no x-organization-id yet),
    // and one shared-NAT browser can starve every other user behind that IP.
    // Read the override flag fresh each boot so scenario tests can toggle
    // rate limiting on per-app without relying on the frozen config module
    // (imported once per worker, outlives individual tests).
    rateLimit:
      (config.isDevelopment || config.isTest) &&
      process.env.RATE_LIMIT_ENABLED !== "true"
        ? false
        : {
            max: Number(process.env.RATE_LIMIT_MAX ?? config.rateLimit.max),
            timeWindow: `${Number(process.env.RATE_LIMIT_WINDOW_MS ?? config.rateLimit.windowMs)}ms`,
            keyGenerator: createTenantKeyGenerator(),
            skipPaths: ["/api/auth/*"],
          },
    elevation: { platformRoles: ["superadmin"] },
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
        validateMode: config.isProduction ? "warn" : "reject",
      },
      queryCache: true,
      metrics: true,
      // Custom health plugin registered in `register-infra-plugins.ts` with
      // Mongo + Flow-engine readiness checks. Arc's default has no domain
      // awareness — `/_health/ready` would 200 while engines are still
      // bootstrapping.
      health: false,
    },
    resourcePrefix: "/api/v1",
    // Explicit `resources` wins over `resourceDir` per arc 2.11. Tests pass a
    // pre-loaded array and skip discovery; in normal boot we call loadResources()
    // per feature-enabled directory (see config/resource-manifest.ts) so disabled
    // features produce zero routes without touching individual resource files.
    // category.resource.ts / product.resource.ts use the factory form
    // `(ctx) => defineResource(...)` and receive the catalog engine via context.
    //
    // ARC_SUPPRESS_WARNINGS=1 mutes loader skip/factory-failure warnings in prod.
    strictResourceDir: config.isProduction,
    strictResources: config.isProduction,
    resources:
      resources ??
      (async (): Promise<ResourceLike[]> => {
        const catalog = await ensureCatalogEngine();
        const dirs = getEnabledResourceDirs(import.meta.url);
        const batches = await Promise.all(
          dirs.map((dir) => loadResources<AppContext>(dir, { context: { catalog } })),
        );
        return batches.flat();
      }),
    plugins: registerInfraPlugins,
    bootstrap: [registerDomainBootstrap],
    afterResources: registerAfterResources,
  };
}
