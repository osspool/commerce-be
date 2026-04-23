# CLAUDE.md — be-prod / logistics

Agent rules for the logistics resource. Inherits from [be-prod/CLAUDE.md](../../../CLAUDE.md).

## What this module is

A thin Arc resource that:

- Owns no Mongoose model. State lives on `Fulfillment` records in `@classytic/order`.
- Wraps `@classytic/carrier-bd` adapters via a process-wide `CarrierRegistry` singleton.
- Exposes BD address taxonomy (unified RedX-aligned + Pathao-native) as REST endpoints.
- Translates HTTP requests → service calls → adapter calls → fulfillment FSM transitions.
- Streams Pathao bulk-upload CSVs server-side for filtered orders.

## Migration history

Built fresh in 2026-04 to replace the legacy `@classytic/bd-logistics` integration. Anything you find referencing `bd-logistics` is a stale doc/comment — that dependency is gone. See git log if you need the historical implementation.

## File map

```
logistics.controller.ts          ← raw Fastify handlers; binds methods in constructor
logistics.plugin.ts              ← warms carrier registry on app onReady
logistics.resource.ts            ← Arc defineResource — disableDefaultRoutes + custom routes
services/
  carrier-registry.ts            ← singleton; builds adapters from config; wires composite resolver
  logistics.service.ts           ← thin orchestrator — adapter calls + fulfillment FSM
utils/
  zones.ts                       ← internal pricing tier table (NOT carrier data)
tests/
  logistics.test.ts              ← fast unit tests (no Mongo) — dataset wiring smoke
  scripts.test.ts                ← config-shape tests (carrier sections optional)
```

## Non-negotiable rules

- **No `@classytic/bd-logistics` imports.** That package was replaced. Use `@classytic/carrier-bd` only.
- **One CarrierRegistry singleton.** The module-level `carrierRegistry` instance in `services/carrier-registry.ts` is the only place adapters are constructed. Resource code calls `carrierRegistry.get(code)` / `carrierRegistry.getDefault()`. Don't `new PathaoAdapter(...)` anywhere else.
- **Providers are optional.** `config.logistics.providers.{redx,pathao,steadfast}` are populated ONLY when their env vars exist. Empty providers object is valid — surface a clear error from the registry, never a `TypeError` from undefined access.
- **Address taxonomy is static.** All `/locations/*` routes return data from `@classytic/bd-areas` or `@classytic/bd-areas/pathao` — zero outbound HTTP. Carrier APIs are called only by `/quote`, `/shipments`, `/pickup-stores`, and `/webhooks/:provider`.
- **Tenant scoping via `x-organization-id`.** Every controller call builds a `LogisticsContext` from the header. Never bypass it.
- **Fulfillment writes go through `@classytic/order` repos.** Never touch the Mongoose model directly. The FSM enforces valid state transitions (`picking → packed → shipped → in_transit → delivered → canceled`).
- **`raw: true` is correct here.** This resource has no model, so Arc's adapter pipeline doesn't apply. The convention `raw: true` for routes (instead of full Arc handler shape) is intentional for this module.

## Adding a new carrier

1. Add config block to `src/config/sections/logistics.config.ts` — gated on its env vars being present.
2. Add a branch in `services/carrier-registry.ts#_build` that constructs the adapter when configured.
3. Add the carrier code to the `CarrierCode` union in `services/carrier-registry.ts`.
4. (Optional) wire a resolver — pass via `areaResolver:` at construction.
5. The route layer doesn't need changes — `/quote`, `/shipments`, `/track`, `/cancel`, `/webhooks/:provider` all dispatch by `carrier` arg.

## Adding a new route

1. Add the handler method on `LogisticsController` in `logistics.controller.ts`. Use the existing `getCtx(req)` + `fail(reply, code, msg)` helpers.
2. Bind it in the constructor's `for (const k of Object.getOwnPropertyNames(...))` loop — already automatic, no manual binding needed.
3. Register the route in `logistics.resource.ts` with `raw: true` and the right permission (`logisticsActions.public | manage | admin`).

## What this module WILL NOT do

- No own Mongoose models. Tracking lives on `Fulfillment` (in `@classytic/order`).
- No carrier-side circuit-breaker UI. Each adapter has a built-in breaker; surface it via `/health` later if needed.
- No checkout-side address picker. The customer-facing checkout uses `@classytic/bd-areas` directly via the SDK — this module's `/locations/*` routes are for admin tools / mobile / size-sensitive consumers.
- No CSV import. Only export. Pathao's bulk-upload page is upload-only by design.

## Routes summary

| Method | Path | Permission |
|---|---|---|
| `GET` | `/logistics/config` | admin |
| `GET` | `/logistics/locations/divisions` | public |
| `GET` | `/logistics/locations/divisions/:division/districts` | public |
| `GET` | `/logistics/locations/areas` | public |
| `GET` | `/logistics/locations/areas/search` | public |
| `GET` | `/logistics/locations/areas/by-postcode` | public |
| `GET` | `/logistics/locations/zones` | public |
| `GET` | `/logistics/locations/estimate` | public |
| `GET` | `/logistics/locations/pathao/cities` | public |
| `GET` | `/logistics/locations/pathao/cities/:cityId/zones` | public |
| `GET` | `/logistics/locations/pathao/search` | public |
| `POST` | `/logistics/quote` | manage |
| `POST` | `/logistics/shipments` | manage |
| `GET` | `/logistics/shipments/:id/track` | manage |
| `POST` | `/logistics/shipments/:id/cancel` | manage |
| `GET` | `/logistics/pickup-stores?provider=` | manage |
| `GET` | `/logistics/export/pathao-csv` | manage |
| `POST` | `/logistics/webhooks/:provider` | public |

## Env

```
LOGISTICS_DEFAULT_PROVIDER=redx | pathao | steadfast

# RedX
REDX_API_URL                       (defaults to sandbox)
REDX_API_KEY
REDX_DEFAULT_PICKUP_STORE_ID       (optional)

# Pathao Aladdin (OAuth password grant)
PATHAO_API_URL                     (sandbox or https://api-hermes.pathao.com)
PATHAO_CLIENT_ID
PATHAO_CLIENT_SECRET
PATHAO_USERNAME
PATHAO_PASSWORD
PATHAO_DEFAULT_STORE_ID            (optional)

# Steadfast
STEADFAST_API_URL
STEADFAST_API_KEY
STEADFAST_API_SECRET
```

Production credentials are **client-owned** — keep them out of the repo and inject via deploy secrets. The committed `.env.dev` only holds sandbox values.

## Tests

Both test files are in `fastTestIncludes` (vitest.shared.ts). They run pure unit tests — no Mongo, no network. Live carrier behaviour is covered exhaustively by `packages/carrier-bd/tests/e2e/`.

```bash
npx vitest run src/resources/logistics/tests --config vitest.config.ts
```
