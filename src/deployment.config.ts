/**
 * Deployment feature configuration — single source of truth.
 *
 * Fork this repo and edit this file to control which features and capability
 * tiers are active for your deployment. Commit the result — this file IS the
 * deployment contract, visible in git history and reviewable in PRs.
 *
 * Tiers (lowest → highest):  'basic' | 'standard' | 'enterprise'
 * 'core' is always-on and cannot be disabled.
 *
 * To disable a feature entirely, remove its key (or comment it out).
 * The backend will not boot its engine or register its routes.
 *
 * Example — IT / service company (no physical stock):
 *   Remove: inventory, warehouse, pos
 *   Keep:   core, accounting, crm, loyalty, promotions
 *
 * See: wiki/features/resource-manifest.md for the full feature → dir table.
 */

type Tier = 'basic' | 'standard' | 'enterprise';

const deployment: Record<string, Tier> = {
  core:        'enterprise',   // products, categories, orders, customers, branches
  inventory:   'enterprise',   // stock management, transfers, purchases
  warehouse:   'enterprise',   // WMS — lots, packages, procurement, replenishment
  pos:         'standard',     // in-store POS terminal
  loyalty:     'standard',     // points, tiers, referrals, redemption
  promotions:  'standard',     // discounts, vouchers, BOGO rules
  orders:      'standard',     // quotations, RFQs, blanket orders, RMA
  accounting:  'enterprise',   // chart of accounts, journal entries, trial balance
  finance:     'standard',     // financial summaries, payment reconciliation
  crm:         'standard',     // pipelines, opportunities, contacts, activities
  analytics:   'standard',     // dashboard analytics, HQ consolidated reports
  cms:         'standard',     // content pages
  media:       'standard',     // image and asset management
  logistics:   'standard',     // shipping providers, delivery zones
  export:      'standard',     // CSV / Excel export
};

export default deployment;
