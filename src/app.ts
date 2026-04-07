/**
 * Application Factory
 *
 * Creates the Fastify app via Arc's createApp factory.
 * Arc handles security, auth, events, cache, metrics, and OpenAPI automatically.
 *
 * Boot order (Arc 2.5.6):
 *   1. Arc core (helmet, CORS, auth, events, cache)
 *   2. plugins()        — infra (DB, audit, SSE, docs, revenue)
 *   3. bootstrap[]      — domain engines (Flow, Promo, Loyalty, Accounting)
 *   4. resources[]      — auto-discovered via loadResources()
 *   5. afterResources() — hooks, background runtime
 */
import "./config/env-loader.js";
import { createApp, loadResources } from "@classytic/arc/factory";
import { createBetterAuthAdapter } from "@classytic/arc/auth";
import { createTenantKeyGenerator } from "@classytic/arc/scope";
import config from "./config/index.js";
import { connectDatabase } from "./config/db.connect.js";
import { eventTransport } from "#lib/events/EventBus.js";
import { setEventApi } from "#lib/events/arcEvents.js";
import registerCorePlugins from "#core/plugins/register-core-plugins.js";
import { initializeBackgroundRuntime } from "#core/factories/background-runtime.js";
import setupFastifyDocs from "./config/fastify-docs.js";
import { registerResourceHooks } from "#shared/hooks.js";
import { eventRegistry } from "#shared/event-registry.js";
import { getAuth } from "#resources/auth/auth.config.js";
import mongoose from "mongoose";
import { auditPlugin } from "@classytic/arc/audit";

import paymentWebhookResource from "./routes/webhooks/payment-webhook.resource.js";
import revenuePlugin from "#shared/revenue/revenue.plugin.js";
import mongoosePlugin from "#config/db.plugin.js";
import sseManagerPlugin from "#core/plugins/sse-manager.plugin.js";

// Engines that own models — must init BEFORE loadResources runs so resource
// files can reference engine-owned models at definition time.
// Engine import — eager top-level singleton, models registered as a side effect
import "#resources/accounting/accounting.engine.js";

// Engine init plugins (boot singletons — no resource registration)
import inventoryInit from "#resources/inventory/inventory-management.plugin.js";
import accountingInit from "#resources/accounting/accounting.plugin.js";
import loyaltyInit from "#resources/sales/loyalty/loyalty.plugin.js";
import promoInit from "#resources/promotions/promo.plugin.js";
import logisticsInit from "#resources/logistics/logistics.plugin.js";
import mediaInit from "#resources/content/media/media.plugin.js";

import type { FastifyInstance } from "fastify";

type AppPreset = "production" | "development" | "testing";

function getPreset(): AppPreset {
  if (config.isProduction) return "production";
  if (config.isTest) return "testing";
  return "development";
}

interface CreateApplicationOptions {
  /**
   * Pre-loaded resources. When provided, skips `loadResources()` auto-discovery.
   * Workaround for vitest on Windows where loadResources's dynamic import
   * chain falls back to bare paths and fails with "protocol 'd:'". Tests
   * should statically import resources and pass them in here.
   */
  resources?: Awaited<ReturnType<typeof loadResources>>;
}

async function createApplication(opts: CreateApplicationOptions = {}): Promise<FastifyInstance> {
  const isInlineWorkerMode = (config.worker?.mode || "inline") === "inline";

  // 1. Connect mongoose FIRST — engines own their models on this connection
  await connectDatabase();

  // The accounting engine is an eager top-level const — models were
  // registered on the default mongoose connection at import time (see
  // `import "#resources/accounting/accounting.engine.js"` above). No
  // explicit init step required.

  // 2. Auto-discover all *.resource.ts files (or use override from tests)
  const resources = opts.resources ?? (await loadResources(import.meta.url, { silent: false }));

  const app = await createApp({
    preset: getPreset(),

    // ── Auth ──
    auth: {
      type: "betterAuth",
      betterAuth: createBetterAuthAdapter({
        auth: getAuth(),
        orgContext: true,
      }),
    },

    // ── Security ──
    cors: {
      ...config.cors,
      allowedHeaders: [
        ...(config.cors.allowedHeaders || [
          "Content-Type",
          "Authorization",
          "X-Requested-With",
          "Accept",
        ]),
        "x-organization-id",
        "x-arc-scope",
      ],
    },
    rateLimit: {
      max: config.rateLimit.max,
      timeWindow: `${config.rateLimit.windowMs}ms`,
      keyGenerator: createTenantKeyGenerator(),
    },
    elevation: { platformRoles: ["superadmin"] },

    // ── Events ──
    stores: { events: eventTransport },
    arcPlugins: {
      events: {
        logEvents: !config.isProduction,
        registry: eventRegistry,
        validateMode: config.isProduction ? "off" : "warn",
      },
      queryCache: true,
      metrics: true,
    },

    // ── Resources (auto-discovered, prefixed under /api/v1) ──
    resourcePrefix: "/api/v1",
    resources,

    // ── Infra plugins (DB, audit, SSE, docs, revenue) ──
    plugins: async (fastify: FastifyInstance) => {
      await fastify.register(mongoosePlugin);

      await fastify.register(auditPlugin, {
        enabled: true,
        stores: ["mongodb"],
        mongoConnection: mongoose.connection as any,
        mongoCollection: "audit_logs",
        ttlDays: parseInt(process.env.AUDIT_TTL_DAYS || "90", 10),
        // Per-resource opt-in (arc 2.6.2): resources mark themselves with
        // `audit: true` (or `audit: { operations: [...] }`) in defineResource().
        // No more exclude list — each resource owns its audit policy.
        autoAudit: {
          operations: ["create", "update", "delete"],
          perResource: true,
        },
      });

      setEventApi(fastify.events);
      await fastify.register(sseManagerPlugin);
      await fastify.register(registerCorePlugins);

      if (config.isProduction) {
        const { idempotencyPlugin } =
          await import("@classytic/arc/idempotency");
        await fastify.register(idempotencyPlugin, {
          enabled: true,
          headerName: "idempotency-key",
          ttlMs: 86400000,
          methods: ["POST", "PUT", "PATCH"],
        });
      }

      await fastify.register(setupFastifyDocs);
      await fastify.register(revenuePlugin);

      fastify.get("/health", async () => ({ success: true, message: "OK" }));
      fastify.log.info(
        { trackProductViews: config.app.trackProductViews === true },
        "Feature flags",
      );

      // Webhooks (outside API versioning — no prefix)
      await fastify.register(paymentWebhookResource.toPlugin());
    },

    // ── Domain engines (init before resources) ──
    bootstrap: [
      // Domain engine init — registers under /api/v1 to match resourcePrefix
      async (fastify) => {
        await fastify.register(
          async (scoped) => {
            await scoped.register(inventoryInit);
            await scoped.register(accountingInit);
            await scoped.register(loyaltyInit);
            await scoped.register(promoInit);
            await scoped.register(logisticsInit);
            await scoped.register(mediaInit);
          },
          { prefix: "/api/v1" },
        );
      },
    ],

    // ── After resources (hooks, background runtime) ──
    afterResources: async (fastify) => {
      registerResourceHooks(fastify);

      // Smart day-close hook — auto-closes POS days on any branch request
      if (config.accounting?.enabled && config.accounting?.mode !== "simple") {
        const { registerDayCloseHook } =
          await import("#resources/accounting/posting/day-close.hook.js");
        registerDayCloseHook(fastify);
      }

      if (isInlineWorkerMode) {
        await initializeBackgroundRuntime({
          mode: "inline",
          enableEventHandlers: true,
          enableCronJobs: config.app.disableCronJobs !== true,
        });
      }
    },
  });

  return app;
}

export { createApplication };
