/**
 * Branch Isolation Audit — TDD validation tests
 *
 * These tests validate reported security and data-boundary issues
 * BEFORE fixes are applied. Each describe block targets a specific issue.
 *
 * HIGH-1: availability/reservation accept arbitrary branchId from query/body
 * HIGH-2: vendor-bill/customer-invoice open items lack organizationId filtering
 * HIGH-3: transfer creation trusts sender/receiverBranchId from payload
 * MEDIUM-1: purchase receipt event emits purchase.supplierName (nonexistent field)
 * MEDIUM-2: pino and fastify-plugin missing from package.json dependencies
 * LOW: erp.index.ts is dead code (not imported anywhere)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Helpers — read source files as strings for structural assertions
// ---------------------------------------------------------------------------
function readSrc(relativePath: string): string {
  return readFileSync(resolve(ROOT, 'src', relativePath), 'utf-8');
}

function readRoot(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf-8');
}

// ---------------------------------------------------------------------------
// HIGH-1: Branch isolation bypass in availability & reservation resources
//
// Both resources accept branchId from req.query / req.body and pass it
// directly to buildFlowContext(). They must instead use
// resolveAuthorizedBranchId() to enforce auth scope matching.
// ---------------------------------------------------------------------------
describe('HIGH-1: availability + reservation branch isolation', () => {
  const availSrc = readSrc('resources/inventory/warehouse/availability/availability.resource.ts');
  const resSrc = readSrc('resources/inventory/warehouse/reservation/reservation.resource.ts');

  describe('availability.resource.ts', () => {
    it('should import resolveAuthorizedBranchId', () => {
      expect(availSrc).toContain('resolveAuthorizedBranchId');
    });

    it('should NOT read branchId directly from req.query without auth validation', () => {
      // The current code does: (req.query as ...).branchId || (req.body as ...).branchId
      // which bypasses auth scope. After fix, it should use resolveAuthorizedBranchId.
      const hasUnsafeBranchRead =
        /req\.query\b.*branchId/.test(availSrc) &&
        !availSrc.includes('resolveAuthorizedBranchId');
      expect(hasUnsafeBranchRead).toBe(false);
    });

    it('should NOT read branchId directly from req.body without auth validation', () => {
      const hasUnsafeBranchRead =
        /req\.body\b.*branchId/.test(availSrc) &&
        !availSrc.includes('resolveAuthorizedBranchId');
      expect(hasUnsafeBranchRead).toBe(false);
    });
  });

  describe('reservation.resource.ts', () => {
    it('should import resolveAuthorizedBranchId', () => {
      expect(resSrc).toContain('resolveAuthorizedBranchId');
    });

    it('should NOT destructure branchId from req.body without auth validation', () => {
      // Current code: const { branchId, ...input } = req.body
      // then uses branchId directly in buildFlowContext
      const hasUnsafeBranchRead =
        /branchId.*req\.body|req\.body.*branchId/.test(resSrc) &&
        !resSrc.includes('resolveAuthorizedBranchId');
      expect(hasUnsafeBranchRead).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// HIGH-2: A/P and A/R open items leak across branches
//
// vendor-bill and customer-invoice resources call
// reconciliations.getOpenItems() without organizationId filtering.
// Journal entries ARE tagged with organizationId, so the query must include it.
// ---------------------------------------------------------------------------
describe('HIGH-2: accounting open items branch isolation', () => {
  const vendorSrc = readSrc('resources/accounting/vendor-bill/vendor-bill.resource.ts');
  const customerSrc = readSrc('resources/accounting/customer-invoice/customer-invoice.resource.ts');

  describe('vendor-bill.resource.ts — openBillsHandler', () => {
    it('should access organizationId from request scope or header', () => {
      // The handler must read the branch context to filter open items
      const readsOrgContext =
        vendorSrc.includes('organizationId') ||
        vendorSrc.includes('x-organization-id') ||
        vendorSrc.includes('scope');
      expect(readsOrgContext).toBe(true);
    });

    it('should pass organizationId filter to getOpenItems', () => {
      // getOpenItems must receive organizationId to prevent cross-branch leaks
      const passesOrgFilter =
        /getOpenItems\([\s\S]*?organizationId/.test(vendorSrc) ||
        /filter:[\s\S]*?organizationId/.test(vendorSrc);
      expect(passesOrgFilter).toBe(true);
    });

    it('should use requireOrgMembership, not requireAuth, for open items', () => {
      expect(vendorSrc).toContain('requireOrgMembership');
      expect(vendorSrc).not.toMatch(/permissions:\s*requireAuth\(\)/);
    });
  });

  describe('customer-invoice.resource.ts — openInvoicesHandler', () => {
    it('should access organizationId from request scope or header', () => {
      const readsOrgContext =
        customerSrc.includes('organizationId') ||
        customerSrc.includes('x-organization-id') ||
        customerSrc.includes('scope');
      expect(readsOrgContext).toBe(true);
    });

    it('should pass organizationId filter to getOpenItems', () => {
      const passesOrgFilter =
        /getOpenItems\([\s\S]*?organizationId/.test(customerSrc) ||
        /filter:[\s\S]*?organizationId/.test(customerSrc);
      expect(passesOrgFilter).toBe(true);
    });

    it('should use requireOrgMembership, not requireAuth, for open items', () => {
      expect(customerSrc).toContain('requireOrgMembership');
      expect(customerSrc).not.toMatch(/permissions:\s*requireAuth\(\)/);
    });
  });
});

// ---------------------------------------------------------------------------
// HIGH-3: Transfer creation not bound to active branch context
//
// transfer.controller.ts passes context.body directly to
// transferService.createTransfer() without verifying that
// senderBranchId or receiverBranchId matches the caller's auth scope.
// ---------------------------------------------------------------------------
describe('HIGH-3: transfer creation branch binding', () => {
  const controllerSrc = readSrc('resources/inventory/transfer/transfer.controller.ts');
  const serviceSrc = readSrc('resources/inventory/transfer/transfer.service.ts');

  it('controller should enforce auth scope on sender or receiver branch', () => {
    // The controller must validate that the caller's authenticated branch
    // matches at least one of the transfer's branch IDs
    const enforcesScope =
      controllerSrc.includes('resolveAuthorizedBranchId') ||
      controllerSrc.includes('callerBranchId') ||
      /scope.*organizationId/.test(controllerSrc) ||
      controllerSrc.includes('x-organization-id');
    expect(enforcesScope).toBe(true);
  });

  it('service should validate caller branch against sender/receiver', () => {
    // createTransfer should accept callerBranchId and validate it
    const validatesBranch =
      serviceSrc.includes('callerBranchId') ||
      serviceSrc.includes('actorBranchId') ||
      /Cross-branch.*denied|caller.*branch|authorized.*branch/i.test(serviceSrc);
    expect(validatesBranch).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MEDIUM-1: Purchase receipt event emits purchase.supplierName
//           but Purchase model has no supplierName field (only supplier ObjectId)
//
// The onCommit callback at line ~408 reads purchase.supplierName which will
// always be undefined on a Mongoose toObject() output.
// ---------------------------------------------------------------------------
describe('MEDIUM-1: purchase receipt event supplier metadata', () => {
  const purchaseModelSrc = readSrc('resources/inventory/purchase-order/models/purchase-order.model.ts');
  const receiveActionSrc = readSrc('resources/inventory/purchase-order/actions/receive-purchase-order.ts');

  it('PurchaseOrder model should NOT have a supplierName field (confirms the drift)', () => {
    // Verify our premise: supplier is an ObjectId ref, not a string name
    expect(purchaseModelSrc).toContain("ref: 'Supplier'");
    // supplierName should NOT be a schema field
    const hasSupplierNameField = /supplierName:\s*\{/.test(purchaseModelSrc);
    expect(hasSupplierNameField).toBe(false);
  });

  it('onCommit should use resolvedSupplierName, not purchase.supplierName', () => {
    const onCommitSection = receiveActionSrc.slice(
      receiveActionSrc.indexOf('onCommit'),
    );
    // Should not cast purchase and read .supplierName (it does not exist on schema)
    const readsGhostField = /purchase.*\.supplierName/.test(onCommitSection);
    expect(readsGhostField).toBe(false);
    // Should use the hoisted closure variable
    expect(onCommitSection).toContain('resolvedSupplierName');
  });

  it('resolvedSupplierName should be declared in receivePurchase outer scope', () => {
    // Hoisted let declaration before withPurchaseTransaction so onCommit closure can access it
    expect(receiveActionSrc).toMatch(/let resolvedSupplierName/);
    // Assigned from populated supplier document inside transaction
    expect(receiveActionSrc).toMatch(/resolvedSupplierName\s*=\s*supplier\?\.name/);
  });
});

// ---------------------------------------------------------------------------
// MEDIUM-2: Dependency hygiene — pino and fastify-plugin not in package.json
//
// Code imports them directly, but they are transitive deps only.
// They must be declared as direct dependencies for clean installs.
// ---------------------------------------------------------------------------
describe('MEDIUM-2: dependency manifest completeness', () => {
  const pkg = JSON.parse(readRoot('package.json'));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

  it('pino should be a direct dependency (imported in logger.ts)', () => {
    expect(allDeps).toHaveProperty('pino');
  });

  it('fastify-plugin should be a direct dependency (imported in register-core-plugins.ts)', () => {
    expect(allDeps).toHaveProperty('fastify-plugin');
  });
});

// ---------------------------------------------------------------------------
// LOW: erp.index.ts was dead code — now deleted
//
// app.ts registers each engine plugin directly via bootstrap[].
// erp.index.ts wrapped the same plugins but was never imported.
// ---------------------------------------------------------------------------
describe('LOW: erp.index.ts removed', () => {
  it('erp.index.ts should no longer exist (dead code deleted)', () => {
    const exists = (() => {
      try { readFileSync(resolve(ROOT, 'src/routes/erp.index.ts')); return true; } catch { return false; }
    })();
    expect(exists).toBe(false);
  });

  it('app.ts should NOT reference erp.index or erp-engines', () => {
    const appSrc = readSrc('app.ts');
    expect(appSrc).not.toContain('erp.index');
    expect(appSrc).not.toContain('erp-engines');
  });
});

// ---------------------------------------------------------------------------
// Logger: unified, no duplicate
//
// be-prod should have ONE logger (src/lib/utils/logger.ts).
// The duplicate src/core/utils/logger.ts has been removed.
// All imports should point to #lib/utils/logger.
// ---------------------------------------------------------------------------
describe('Logger unification', () => {
  it('core/utils/logger.ts should not exist (duplicate removed)', () => {
    const exists = (() => {
      try { readFileSync(resolve(ROOT, 'src/core/utils/logger.ts')); return true; } catch { return false; }
    })();
    expect(exists).toBe(false);
  });

  it('lib/utils/logger.ts should exist as the single logger', () => {
    const exists = (() => {
      try { readFileSync(resolve(ROOT, 'src/lib/utils/logger.ts')); return true; } catch { return false; }
    })();
    expect(exists).toBe(true);
  });

  it('no source file should import from #core/utils/logger', () => {
    // All worker files should have been redirected to #lib/utils/logger
    const loggerSrc = readSrc('lib/utils/logger.ts');
    expect(loggerSrc).toContain('pino');
    // Ensure the deleted file isn't referenced
    const workerFiles = ['lib/worker/signals.ts', 'lib/worker/WorkerBootstrap.ts', 'lib/worker/WorkerHealthServer.ts'];
    for (const file of workerFiles) {
      const src = readSrc(file);
      expect(src).not.toContain('#core/utils/logger');
      expect(src).toContain('#lib/utils/logger');
    }
  });

  it('logger should not export unused createFastifyLogger', () => {
    const loggerSrc = readSrc('lib/utils/logger.ts');
    expect(loggerSrc).not.toContain('createFastifyLogger');
  });
});

// ---------------------------------------------------------------------------
// Product sync event wiring validation
//
// Verifies that the inventory event handlers properly subscribe to
// Flow events for product quantity syncing.
// ---------------------------------------------------------------------------
describe('Product sync: event wiring', () => {
  const handlersSrc = readSrc('resources/inventory/inventory.handlers.ts');

  it('should subscribe to FlowEvents.MOVE_DONE for quantity sync', () => {
    expect(handlersSrc).toContain('MOVE_DONE');
  });

  it('should subscribe to FlowEvents.RESERVATION_RELEASED for quantity sync', () => {
    expect(handlersSrc).toContain('RESERVATION_RELEASED');
  });

  it('should subscribe to product:created to seed initial quants', () => {
    expect(handlersSrc).toContain('product:created');
  });

  it('should subscribe to product:variants.changed for cache invalidation', () => {
    expect(handlersSrc).toContain('product:variants.changed');
  });

  it('should call syncProductQuantityFromQuant on stock movements', () => {
    expect(handlersSrc).toContain('syncProductQuantityFromQuant');
  });
});

// ---------------------------------------------------------------------------
// resolveAuthorizedBranchId contract tests (unit)
// ---------------------------------------------------------------------------
describe('resolveAuthorizedBranchId — cross-branch guard', () => {
  // Dynamic import to test the actual function
  let resolveAuthorizedBranchId: typeof import('../src/resources/inventory/flow/context-helpers.js').resolveAuthorizedBranchId;

  const BRANCH_A = '507f1f77bcf86cd799439011';
  const BRANCH_B = '507f1f77bcf86cd799439022';

  type PartialReq = {
    scope?: { organizationId?: string };
    user?: { organizationId?: string; orgId?: string };
    headers?: Record<string, string | undefined>;
  };

  function mkReq(r: PartialReq) {
    return { headers: {}, ...r } as any;
  }

  // Use dynamic import so test file can be loaded even if module resolution differs
  beforeAll(async () => {
    const mod = await import('../src/resources/inventory/flow/context-helpers.js');
    resolveAuthorizedBranchId = mod.resolveAuthorizedBranchId;
  });

  it('returns authBranchId when no specific branch requested', () => {
    const result = resolveAuthorizedBranchId(mkReq({ scope: { organizationId: BRANCH_A } }));
    expect(result).toBe(BRANCH_A);
  });

  it('returns authBranchId when requested branch matches', () => {
    const result = resolveAuthorizedBranchId(
      mkReq({ scope: { organizationId: BRANCH_A } }),
      BRANCH_A,
    );
    expect(result).toBe(BRANCH_A);
  });

  it('throws 403 when requested branch differs from auth scope', () => {
    expect(() =>
      resolveAuthorizedBranchId(
        mkReq({ scope: { organizationId: BRANCH_A } }),
        BRANCH_B,
      ),
    ).toThrow(/cross-branch/i);
  });

  it('throws 400 when no auth context present', () => {
    expect(() => resolveAuthorizedBranchId(mkReq({}))).toThrow(/organization context/i);
  });
});
