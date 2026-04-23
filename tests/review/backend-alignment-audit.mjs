import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

function exists(relPath) {
  return fs.existsSync(path.join(root, relPath));
}

function warn(message, details = '') {
  process.stderr.write(`WARN: ${message}\n`);
  if (details) process.stderr.write(`${details}\n`);
}

function ok(message) {
  process.stdout.write(`OK: ${message}\n`);
}

let warnings = 0;

const inventoryRepositoryPath = 'be-prod/src/resources/inventory/inventory.repository.ts';
const inventoryRepository = read(inventoryRepositoryPath);
if (
  inventoryRepository.includes('for (const [skuRef, entry] of skuQuantMap)') &&
  inventoryRepository.includes('for (const pid of pids)') &&
  inventoryRepository.includes('result.set(`${pid}_${skuRef}`')
) {
  warnings++;
  warn(
    'Variant stock aliasing detected in inventory repository shim.',
    `${inventoryRepositoryPath} maps every non-productId skuRef to every requested productId, which can leak variant stock across unrelated products.`,
  );
} else {
  ok('Inventory repository does not show broad variant aliasing pattern.');
}

const archiveRepositoryPath = 'be-prod/src/resources/archive/archive.repository.ts';
const archiveRepository = read(archiveRepositoryPath);
const legacyStockMovementPath = 'be-prod/src/resources/inventory/stockMovement.model.ts';
if (
  archiveRepository.includes("#resources/inventory/stockMovement.model.js") &&
  !exists(legacyStockMovementPath)
) {
  warnings++;
  warn(
    'Archive repository references a missing legacy StockMovement model.',
    `${archiveRepositoryPath} loads #resources/inventory/stockMovement.model.js but ${legacyStockMovementPath} does not exist.`,
  );
} else {
  ok('Archive repository stock movement loader resolves to an existing file.');
}

const productRepositoryPath = 'be-prod/src/resources/catalog/products/product.repository.ts';
const productRepository = read(productRepositoryPath);
if (productRepository.includes("mongoose.model('StockEntry')")) {
  warnings++;
  warn(
    'Product sellability check still depends on legacy StockEntry.',
    `${productRepositoryPath} uses mongoose.model('StockEntry') instead of Flow availability.`,
  );
} else {
  ok('Product sellability path does not depend on legacy StockEntry.');
}

const inventoryControllerPath = 'be-prod/src/resources/inventory/inventory.controller.ts';
const inventoryController = read(inventoryControllerPath);
if (
  inventoryController.includes('const { branchId, threshold } = req.query') ||
  inventoryController.includes('const orgId = branchId || branch;')
) {
  warnings++;
  warn(
    'Inventory endpoints accept branch identifiers directly from request params/query.',
    `${inventoryControllerPath} builds Flow context from query-provided branch ids instead of the active auth scope.`,
  );
} else {
  ok('Inventory controller appears to use request scope rather than raw branch query overrides.');
}

const posControllerPath = 'be-prod/src/resources/sales/pos/pos.controller.ts';
const posController = read(posControllerPath);
if (
  posController.includes('} else if (branchId) {') &&
  posController.includes('branch = await branchRepository.getById(branchId);')
) {
  warnings++;
  warn(
    'POS order creation accepts caller-supplied branch selection.',
    `${posControllerPath} resolves branchId/branchSlug from the request body without comparing to the active organization scope.`,
  );
} else {
  ok('POS controller branch resolution appears to be scope-bound.');
}

const inventoryPluginPath = 'be-prod/src/resources/inventory/inventory-management.plugin.ts';
const inventoryPlugin = read(inventoryPluginPath);
if (
  inventoryPlugin.includes('const user = req.user as { organizationId?: string } | undefined;') &&
  !inventoryPlugin.includes('req.scope')
) {
  warnings++;
  warn(
    'Inventory bootstrap hook only inspects req.user.organizationId.',
    `${inventoryPluginPath} ignores req.scope.organizationId and x-organization-id even though Flow context helpers prefer them.`,
  );
} else {
  ok('Inventory bootstrap hook inspects auth scope sources consistently.');
}

const purchaseNotifierPath = 'be-prod/src/resources/notifications/notification.publish.ts';
const purchaseNotifier = read(purchaseNotifierPath);
const purchaseInvoiceServicePath = 'be-prod/src/resources/inventory/purchase/purchase-invoice.service.ts';
const purchaseInvoiceService = read(purchaseInvoiceServicePath);
const purchaseEventContractPath = 'be-prod/src/resources/inventory/purchase/events.ts';
const purchaseEventContract = read(purchaseEventContractPath);
const invoiceEventsPath = 'be-prod/src/resources/accounting/invoice/invoice.events.ts';
const invoiceEvents = read(invoiceEventsPath);
if (
  purchaseNotifier.includes('organizationId: string;') &&
  purchaseEventContract.includes('branchId: string;') &&
  invoiceEvents.includes('partnerId: data.supplierId as string') &&
  purchaseInvoiceService.includes('notifyEvent.purchaseReceived({')
) {
  warnings++;
  warn(
    'Purchase receipt event payloads are misaligned across emitters and consumers.',
    `${purchaseNotifierPath}, ${purchaseEventContractPath}, ${purchaseInvoiceServicePath}, and ${invoiceEventsPath} disagree on whether purchase:received carries branchId vs organizationId and whether supplier/total fields are present.`,
  );
} else {
  ok('Purchase receipt event payloads appear aligned across emitter and consumers.');
}

if (warnings > 0) {
  process.stderr.write(`\nAlignment audit completed with ${warnings} warning(s).\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('\nAlignment audit completed without warnings.\n');
}
