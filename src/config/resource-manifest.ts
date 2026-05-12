/**
 * Feature → resource directory mapping.
 *
 * Each entry says: "load this dir when ANY of these features is enabled".
 * 'always' entries load unconditionally (infrastructure routes).
 *
 * loadResources() is called per-dir and results are flatted — disabled features
 * produce zero routes without touching any resource file.
 *
 * See: wiki/features/resource-manifest.md for the full table + deployment matrix.
 */

import { isFeatureEnabled } from '#config/features.js';

type AnyOf = string[];
type DirEntry = { features: AnyOf | 'always'; dir: string };

// Relative to be-prod/src/resources/ — keep sorted within each group
const RESOURCE_DIRS: DirEntry[] = [
  // ── Infrastructure (always-on, no feature gate) ──────────────────────────
  { features: 'always', dir: 'auth' },
  { features: 'always', dir: 'platform' },
  { features: 'always', dir: 'audit' },
  { features: 'always', dir: 'archive' },
  { features: 'always', dir: 'notifications' },
  { features: 'always', dir: 'approval' },
  { features: 'always', dir: 'commerce' },

  // ── Core commerce ─────────────────────────────────────────────────────────
  // 'core' is always included by features.ts (parseEnabledFeatures forces it),
  // so these are effectively always-on — but expressed explicitly for clarity.
  { features: ['core'], dir: 'catalog' },
  { features: ['core'], dir: 'sales/cart' },
  { features: ['core'], dir: 'sales/customers' },
  { features: ['core'], dir: 'sales/orders' },
  { features: ['core'], dir: 'sales/pricelist' },
  { features: ['core'], dir: 'payments' },
  { features: ['core'], dir: 'transaction' },

  // ── Extended orders (quotations, RFQ, blanket, RMA) ───────────────────────
  { features: ['orders'], dir: 'sales/blanket-order' },
  { features: ['orders'], dir: 'sales/quotations' },
  { features: ['orders'], dir: 'sales/rfq' },
  { features: ['orders'], dir: 'sales/rma' },

  // ── POS ───────────────────────────────────────────────────────────────────
  { features: ['pos'], dir: 'sales/pos' },

  // ── Loyalty program ───────────────────────────────────────────────────────
  { features: ['loyalty'], dir: 'sales/loyalty' },

  // ── Inventory + WMS ───────────────────────────────────────────────────────
  // Loaded when any of: inventory, warehouse, or pos is enabled.
  // All three need the Flow engine (inventoryInit). The entire inventory/ dir
  // is loaded recursively — tier-gating (basic/standard/enterprise) is handled
  // per-resource via meetsMinTier(), not by dir exclusion.
  { features: ['inventory', 'warehouse', 'pos'], dir: 'inventory' },

  // ── Accounting + Finance dashboard ────────────────────────────────────────
  { features: ['accounting'], dir: 'accounting' },
  { features: ['accounting'], dir: 'finance' },

  // ── CRM ───────────────────────────────────────────────────────────────────
  { features: ['crm'], dir: 'crm' },

  // ── Analytics + HQ consolidated dashboard ────────────────────────────────
  { features: ['analytics'], dir: 'analytics' },
  { features: ['analytics'], dir: 'admin' },

  // ── CMS ───────────────────────────────────────────────────────────────────
  { features: ['cms'], dir: 'content' },

  // ── Logistics ─────────────────────────────────────────────────────────────
  { features: ['logistics'], dir: 'logistics' },

  // ── Promotions ────────────────────────────────────────────────────────────
  { features: ['promotions'], dir: 'promotions' },
];

/**
 * Returns absolute file:// URLs for all dirs whose feature is currently enabled.
 * Pass `import.meta.url` from the call site (create-arc-app-options.ts).
 */
export function getEnabledResourceDirs(callerFileUrl: string): string[] {
  return RESOURCE_DIRS
    .filter(({ features }) =>
      features === 'always' || features.some((f) => isFeatureEnabled(f)),
    )
    .map(({ dir }) => new URL(`../../resources/${dir}`, callerFileUrl).href);
}
