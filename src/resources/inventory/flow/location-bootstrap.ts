/**
 * Location Bootstrap — seeds default warehouse node and locations per branch.
 *
 * Each branch (BA org) gets its own Flow scope with:
 * - One default warehouse node
 * - Four virtual locations: stock, vendor, customer, adjustment
 *
 * Idempotent — safe to call on every request (cached by bootstrappedOrgs set).
 */

import type { FlowEngine, LocationType } from '@classytic/flow';
import type { Model } from 'mongoose';
import { ADJUSTMENT_LOCATION, CUSTOMER_LOCATION, DEFAULT_LOCATION, VENDOR_LOCATION } from './context-helpers.js';
import { getFlowEngine } from './flow-engine.js';

interface LocationDef {
  code: string;
  name: string;
  type: LocationType;
  allowNegativeStock: boolean;
}

const LOCATION_DEFS: LocationDef[] = [
  { code: DEFAULT_LOCATION, name: 'Stock', type: 'storage', allowNegativeStock: false },
  { code: VENDOR_LOCATION, name: 'Vendor', type: 'vendor', allowNegativeStock: true },
  { code: CUSTOMER_LOCATION, name: 'Customer', type: 'customer', allowNegativeStock: true },
  { code: ADJUSTMENT_LOCATION, name: 'Adjustment', type: 'inventory_loss', allowNegativeStock: true },
];

/**
 * Ensure default locations exist for a specific branch (organizationId).
 * Idempotent — safe to call multiple times.
 */
export async function bootstrapLocationsForOrg(organizationId: string): Promise<{ created: number; existing: number }> {
  const flow: FlowEngine = getFlowEngine();
  let created = 0;
  let existing = 0;

  // First, ensure a default node exists
  let node = await flow.repositories.node.getByQuery(
    { isDefault: true },
    { organizationId, throwOnNotFound: false, lean: true },
  );

  if (!node) {
    node = await flow.repositories.node.create(
      {
        organizationId,
        code: 'DEFAULT',
        name: 'Default Warehouse',
        type: 'warehouse',
        status: 'active',
        isDefault: true,
      } as Record<string, unknown>,
      { organizationId },
    );
  }

  const nodeId = String(node._id);

  for (const def of LOCATION_DEFS) {
    const exists = await flow.repositories.location.getByQuery(
      { code: def.code, nodeId },
      { organizationId, throwOnNotFound: false },
    );

    if (exists) {
      existing++;
      continue;
    }

    // System locations are virtual (vendor/customer/adjustment) or the default stock bin.
    // They are not physically scanned on receipt — leave `barcode` unset so the partial
    // unique index on `barcode` doesn't reject user-assigned scannable codes later.
    await flow.repositories.location.create(
      {
        organizationId,
        nodeId,
        code: def.code,
        name: def.name,
        type: def.type,
        status: 'active',
        allowNegativeStock: def.allowNegativeStock,
        allowReservations: def.code === DEFAULT_LOCATION,
      },
      { organizationId },
    );
    created++;
  }

  return { created, existing };
}

/**
 * Bootstrap locations for all existing branches.
 * Used during initial migration.
 */
export async function bootstrapAllLocations(
  BranchModel: Model<{ _id: unknown }>,
): Promise<{ total: number; created: number }> {
  const branches = await BranchModel.find({}, '_id').lean();
  let totalCreated = 0;

  for (const branch of branches) {
    const { created } = await bootstrapLocationsForOrg(String(branch._id));
    totalCreated += created;
  }

  return { total: branches.length, created: totalCreated };
}
