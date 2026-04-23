import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Tests requiring MongoMemoryReplSet (transaction support).
 * Run via vitest.replset.config.ts — excluded from the integration-shared-db pool.
 *
 * NOTE: Stale entries pointing to deleted test files have been removed.
 */
const replSetTests = [
  'tests/integration/branch-membership-e2e.test.ts',
  'tests/integration/commerce-inventory-e2e.test.ts',
  'tests/integration/inventory-flow-e2e.test.js',
  'tests/integration/inventory-flow-integration.test.ts',
  'tests/integration/inventory-multibranch-e2e.test.ts',
  'tests/integration/inventory-stock-e2e.test.ts',
  'tests/integration/inventory-adjustment-location.test.ts',
  'tests/integration/loyalty-arc-routes.test.ts',
  'tests/integration/loyalty-e2e.test.ts',
  'tests/integration/loyalty-multi-branch-e2e.test.ts',
  'tests/integration/order-loyalty-config-e2e.test.ts',
  'tests/integration/product-stock-lifecycle.test.ts',
  'tests/integration/warehouse-scenarios.test.ts',
  'tests/integration/stock-warehouse-flow-alignment.test.ts',
  'tests/integration/warehouse-qc-e2e.test.ts',
  'tests/integration/warehouse-certification-e2e.test.ts',
  'tests/integration/warehouse-mode-standard-certification.test.ts',
  'tests/integration/warehouse-mode-enterprise-certification.test.ts',
  'tests/integration/wms-cycle-count-smoke.test.ts',
  'tests/integration/wms-procurement-smoke.test.ts',
  'tests/integration/wms-cost-valuation-smoke.test.ts',
  'tests/integration/wms-trace-smoke.test.ts',
  'tests/integration/revenue-v2-smoke.test.ts',
  'tests/integration/revenue-order-workflow.test.ts',
  'tests/integration/order-revenue-ledger-e2e.test.ts',
  'tests/integration/order-cod-settlement-e2e.test.ts',
  'tests/integration/order-refund-e2e.test.ts',
  'tests/integration/rma-partial-refund-e2e.test.ts',
  'tests/integration/pos-delivery-fulfillment-e2e.test.ts',
  'tests/integration/inventory-reports-e2e.test.ts',
  'tests/integration/erp-stock-lifecycle.test.ts',
  'tests/integration/erp-full-cycle.test.ts',
  'tests/integration/erp-gap-finder.test.ts',
  'tests/integration/http-erp-golden-path.test.ts',
  'tests/integration/orders-e2e.test.ts',
  'tests/integration/guest-checkout-e2e.test.ts',
  'tests/integration/cart-order-fulfillment-e2e.test.ts',
  'tests/integration/cart-behavior.test.ts',
  'tests/integration/cart-variant-dedup.test.ts',
  'tests/integration/pos-ecom-alignment.test.ts',
  'tests/integration/quotation-to-order.test.ts',
  'tests/integration/quotation-routes.test.ts',
  'tests/integration/invoice-pdf.test.ts',
  'tests/integration/order-concurrency-e2e.test.ts',
  'tests/integration/branch-isolation-e2e.test.ts',
  'tests/integration/pos-scenarios.test.ts',
  'tests/integration/reservation-lifecycle.test.ts',
  'tests/integration/vat-purchase-sale-cycle.test.ts',
  'tests/integration/mushak-compliance-e2e.test.ts',
  'tests/integration/vat-nbr-compliance-real-world.test.ts',
  // Scenario-based integration tests — each owns its own MongoMemoryReplSet
  // via tests/helpers/scenario-setup.ts. Full workflow + event-bus coverage.
  'tests/integration/order-event-sequence.scenario.test.ts',
  'tests/integration/order-permission-audit.scenario.test.ts',
  'tests/integration/refund-compensation-saga.scenario.test.ts',
  'tests/integration/pos-shift-close-concurrency.scenario.test.ts',
  'tests/integration/pos-shift-lifecycle.test.ts',
  'tests/integration/pos-shift-aggregation.test.ts',
  'tests/integration/multi-branch-transfer.scenario.test.ts',
  'tests/integration/inventory-transfer-location.scenario.test.ts',
  'tests/integration/inventory-purchase-location.scenario.test.ts',
  'tests/integration/inventory-transfer-cancel.scenario.test.ts',
  'tests/integration/inventory-bootstrap-idempotency.scenario.test.ts',
  'tests/integration/inventory-transfer-receive-location.scenario.test.ts',
  'tests/integration/inventory-branch-switching.scenario.test.ts',
  'tests/integration/inventory-purchase-all-or-nothing.scenario.test.ts',
  'tests/integration/inventory-replenishment.scenario.test.ts',
  'tests/integration/inventory-scrap-execute.scenario.test.ts',
  'tests/integration/inventory-supplier-crud.test.ts',
  // 2026-04 WMS primitives full end-to-end
  'tests/integration/wms-primitives-full-scenario.test.ts',
  'tests/integration/commerce-parity-scenarios.scenario.test.ts',
  'tests/integration/promo-evaluation.scenario.test.ts',
  'tests/integration/promo-cross-branch.scenario.test.ts',
  'tests/integration/checkout-promo-e2e.scenario.test.ts',
  'tests/integration/order-lifecycle-e2e.scenario.test.ts',
  'tests/integration/fulfillment-webhook-org-resolution.scenario.test.ts',
  'tests/integration/fulfillment-workflow.scenario.test.ts',
  'tests/integration/warehouse-scenarios.scenario.test.ts',
  'tests/integration/inventory-management-pagination.scenario.test.ts',
  'tests/integration/inventory-adjust-perf.scenario.test.ts',
  'tests/integration/validate-stock-variant-resolution.scenario.test.ts',
  'tests/integration/platform-config-e2e.test.ts',
  'tests/integration/users-crud-e2e.test.ts',
  'tests/integration/index-tenant-regression.test.ts',
  'tests/integration/multi-branch-consolidation.test.ts',
  'tests/integration/crm-e2e.test.ts',
  'tests/integration/crm-http-e2e.test.ts',
  'tests/integration/commerce-pricing-scenario.test.ts',
  // Per-subsystem scenario suites — each owns its own replset via bootScenarioApp.
  'tests/integration/payments/**/*.test.ts',
  'tests/integration/logistics/**/*.test.ts',
  'tests/integration/notifications/**/*.test.ts',
  'tests/integration/analytics/**/*.test.ts',
  'tests/integration/security/**/*.test.ts',
  'tests/integration/branches/**/*.test.ts',
];

export const paymentsTestIncludes = ['tests/integration/payments/**/*.test.ts'];
export const logisticsTestIncludes = ['tests/integration/logistics/**/*.test.ts'];
export const notificationsTestIncludes = ['tests/integration/notifications/**/*.test.ts'];
export const analyticsTestIncludes = ['tests/integration/analytics/**/*.test.ts'];
export const securityTestIncludes = ['tests/integration/security/**/*.test.ts'];
export const branchesTestIncludes = ['tests/integration/branches/**/*.test.ts'];

export const fastTestIncludes = [
  'tests/app-factory-options.test.ts',
  'tests/app-factory.test.ts',
  'tests/health.test.ts',
  'tests/env-validator-logging.test.ts',
  'tests/payment-webhook-rate-limit.test.ts',
  'tests/accounting-reports.utils.test.ts',
  'tests/business-type-posting.test.ts',
  'tests/cod-posting.test.ts',
  'tests/pathao-csv-row.test.ts',
  'tests/flow-context-helpers.test.ts',
  'tests/checkout.utils.test.js',
  'tests/config-utils.test.ts',
  'tests/cost-price-filter.test.ts',
  'tests/finance-summary.test.js',
  'tests/permissions.test.ts',
  'tests/pos-event-handler.test.ts',
  'tests/report.utils.test.ts',
  'tests/revenue-refund-enrichment.test.js',
  'tests/transaction-statement.test.js',
  'tests/vat-invoice.service.test.js',
  'tests/vat.utils.test.js',
  'src/resources/logistics/tests/scripts.test.ts',
  'src/resources/logistics/tests/logistics.test.ts',
  'src/resources/logistics/tests/resolve-zone.test.ts',
  'tests/branch-isolation-audit.test.ts',
  'tests/branch-isolation-bugs.test.ts',
  'tests/ledger-bridge-shape.test.ts',
  'tests/media-v3-smoke.test.ts',
  'tests/multi-currency-purchase.test.ts',
  'src/resources/inventory/purchase-order/purchase-order.utils.test.ts',
  'src/resources/inventory/inventory.jobs.test.ts',
  'src/resources/inventory/inventory.resource-config.test.ts',
];

export const externalTestIncludes: string[] = [];

export const sharedDbAppBootIncludes = [
  'tests/app-boot.test.ts',
  'tests/arc-idempotency-mongodb.e2e.test.ts',
  'tests/auth-permissions.test.ts',
  'tests/auth.test.js',
  'tests/email-verification.test.ts',
  'tests/migration-verify.test.js',
  'tests/order-booking.smoke.test.ts',
];

export const sharedDbDomainIncludes = [
  'tests/branch-operations.test.ts',
  'tests/category-product-sync.test.js',
  'tests/customer-membership.test.ts',
  'tests/event-integration-e2e.test.ts',
  'tests/shipping-service.test.ts',
  'tests/stress-and-edge-cases.test.ts',
];

export const integrationSharedIncludes = ['tests/integration/**/*.test.{js,ts}'];
export const integrationSharedExcludes = replSetTests;
export const replSetIncludes = replSetTests;

export function createBaseConfig() {
  return defineConfig({
    test: {
      globals: true,
      environment: 'node',
      coverage: {
        provider: 'v8',
        reporter: ['text', 'html', 'lcov'],
        exclude: ['node_modules/**', 'tests/**', '**/*.config.ts'],
      },
      exclude: ['node_modules/**', 'test/**'],
    },
    resolve: {
      alias: {
        '#config': path.resolve(__dirname, './src/config'),
        '#core': path.resolve(__dirname, './src/core'),
        '#shared': path.resolve(__dirname, './src/shared'),
        '#resources': path.resolve(__dirname, './src/resources'),
        '#routes': path.resolve(__dirname, './src/routes'),
        '#lib': path.resolve(__dirname, './src/lib'),
      },
    },
  });
}
