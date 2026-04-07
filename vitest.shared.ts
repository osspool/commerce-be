import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const replSetTests = [
  'tests/integration/branch-membership-e2e.test.ts',
  'tests/integration/commerce-inventory-e2e.test.ts',
  'tests/integration/inventory-flow-e2e.test.js',
  'tests/integration/inventory-flow-integration.test.ts',
  'tests/integration/inventory-hardening.test.js',
  'tests/integration/inventory-multibranch-e2e.test.ts',
  'tests/integration/inventory-services.test.js',
  'tests/integration/inventory-stock-e2e.test.ts',
  'tests/integration/loyalty-arc-routes.test.ts',
  'tests/integration/loyalty-e2e.test.ts',
  'tests/integration/loyalty-multi-branch-e2e.test.ts',
  'tests/integration/order-loyalty-config-e2e.test.ts',
  'tests/integration/product-stock-lifecycle.test.ts',
  'tests/integration/variant-gen-inventory-sync.test.ts',
  'tests/integration/warehouse-scenarios.test.ts',
];

export const fastTestIncludes = [
  'tests/accounting-reports.utils.test.ts',
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
];

export const externalTestIncludes = [
  'src/resources/logistics/tests/redx-integration.test.ts',
];

export const sharedDbAppBootIncludes = [
  'tests/app-boot.test.ts',
  'tests/auth-permissions.test.ts',
  'tests/auth.test.js',
  'tests/email-verification.test.ts',
  'tests/media.test.js',
  'tests/migration-verify.test.js',
];

export const sharedDbDomainIncludes = [
  'tests/branch-operations.test.ts',
  'tests/cart-operations.test.ts',
  'tests/category-product-sync.test.js',
  'tests/customer-membership.test.ts',
  'tests/event-integration-e2e.test.ts',
  'tests/idempotency.service.test.js',
  'tests/shipping-service.test.ts',
  'tests/stress-and-edge-cases.test.ts',
  'src/resources/logistics/tests/logistics.test.ts',
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
        exclude: [
          'node_modules/**',
          'tests/**',
          '**/*.config.ts',
        ],
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
