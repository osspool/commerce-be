/**
 * Central Event Registry
 *
 * All domain events are registered here for catalog introspection
 * and optional schema validation on publish. Pass this registry to the
 * eventPlugin options — done by `create-arc-app-options.ts`.
 *
 * Package-shipped events (structurally compatible with Arc's
 * `EventDefinitionOutput`) are registered at module load time so the
 * registry is populated before the app boots. Each definition carries:
 *   - a Zod schema (source of truth for the payload shape), and
 *   - a JSON Schema (derived via `z.toJSONSchema()`) that Arc uses for
 *     OpenAPI introspection and optional publish-time validation.
 *
 * To register host-specific events, call `eventRegistry.register(...)`
 * at import time from this file (keep it ordered alphabetically by
 * package for easy scanning).
 */

import { createEventRegistry, type EventDefinitionOutput } from '@classytic/arc/events';
import { type CatalogEventDefinition, catalogEventDefinitions } from '@classytic/catalog';
import { type FlowEventDefinition, flowEventDefinitions } from '@classytic/flow';
import { type InvoiceEventDefinition, invoiceEventDefinitions } from '@classytic/invoice';
import { type LedgerEventDefinition, ledgerEventDefinitions } from '@classytic/ledger';
import { type LoyaltyEventDefinition, loyaltyEventDefinitions } from '@classytic/loyalty';
import { type OrderEventDefinition, orderEventDefinitions } from '@classytic/order';
import { type PromoEventDefinition, promoEventDefinitions } from '@classytic/promo';
import { type RevenueEventDefinition, revenueEventDefinitions } from '@classytic/revenue';
import { accountingEventDefinitions } from '#resources/accounting/events/event-definitions.js';

export const eventRegistry = createEventRegistry();

// Register every event shipped by the commerce packages. One `for` loop per
// catalog keeps the origin obvious in stack traces if a schema ever fails
// to parse at registration time. Order is alphabetical by package.
for (const def of catalogEventDefinitions as ReadonlyArray<CatalogEventDefinition>) {
  eventRegistry.register(def);
}
for (const def of flowEventDefinitions as ReadonlyArray<FlowEventDefinition>) {
  eventRegistry.register(def);
}
for (const def of invoiceEventDefinitions as ReadonlyArray<InvoiceEventDefinition>) {
  eventRegistry.register(def);
}
for (const def of ledgerEventDefinitions as ReadonlyArray<LedgerEventDefinition>) {
  eventRegistry.register(def);
}
for (const def of loyaltyEventDefinitions as ReadonlyArray<LoyaltyEventDefinition>) {
  eventRegistry.register(def);
}
for (const def of orderEventDefinitions as ReadonlyArray<OrderEventDefinition>) {
  eventRegistry.register(def);
}
for (const def of promoEventDefinitions as ReadonlyArray<PromoEventDefinition>) {
  eventRegistry.register(def);
}
for (const def of revenueEventDefinitions as ReadonlyArray<RevenueEventDefinition>) {
  eventRegistry.register(def);
}

// Host-internal events emitted by be-prod (order/fulfillment/COD/etc).
// Registering them gives the same publish-time validation guarantee
// (`validateMode: 'reject'` in dev/test) the package events get, and
// lets `wrapWithSchema(definition, handler)` validate at the subscriber.
for (const def of accountingEventDefinitions as ReadonlyArray<EventDefinitionOutput>) {
  eventRegistry.register(def);
}
