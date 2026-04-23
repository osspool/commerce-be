/**
 * Inventory resource config — Arc primitive coverage.
 *
 * Uses Arc's `createConfigTestSuite` to generate field-permission, pipeline,
 * event, and permission-callback tests directly from each resource's
 * `defineResource()` definition. No DB, no replSet, no app boot required —
 * each suite runs as a pure config-shape assertion.
 *
 * Why this exists:
 *   - The integration suites (`inventory-purchase-location.scenario.test.ts`,
 *     etc.) cover end-to-end behavior. They DON'T cover the resource-config
 *     contract: that the `events` map declares the right handlers, that
 *     `permissions` callbacks are functions, that the field rules are
 *     well-formed.
 *   - A removed event handler or a typo'd permissions key would slip past
 *     the integration suite (the route still 200s, just with subtle behavior
 *     changes). `createConfigTestSuite` is the cheap regression net.
 *   - Zero infrastructure: runs in the fast Vitest pool, ~1ms per assertion.
 *
 * Each `createConfigTestSuite(resource)` call generates ~5–15 tests
 * depending on what the resource declares (events, fields, pipe, permissions).
 */

import { createConfigTestSuite } from '@classytic/arc/testing';

import purchaseOrderResource from './purchase-order/purchase-order.resource.js';
import stockRequestResource from './stock-request/stock-request.resource.js';
import supplierResource from './supplier/supplier.resource.js';
import transferResource from './transfer/transfer.resource.js';

createConfigTestSuite(purchaseOrderResource as never);
createConfigTestSuite(transferResource as never);
createConfigTestSuite(stockRequestResource as never);
createConfigTestSuite(supplierResource as never);
