/**
 * Feature License — env-based module + tier gating.
 *
 * The SOFTWARE SELLER controls which features and tiers each deployment gets.
 *
 * ENV format:
 *   ENABLED_FEATURES=core,loyalty:standard,pos,inventory:enterprise,warehouse:standard
 *
 * Format per entry: "featureId" (defaults to highest tier) or "featureId:tier"
 *
 * Tiers (ordered lowest → highest):
 *   - basic     — minimal functionality
 *   - standard  — default, most features
 *   - enterprise — full feature set
 *
 * If ENABLED_FEATURES is not set → all features at enterprise (dev mode).
 */

// ── Tier Definitions ──

export const TIERS = ['basic', 'standard', 'enterprise'] as const;
export type FeatureTier = (typeof TIERS)[number];

const TIER_RANK: Record<FeatureTier, number> = { basic: 0, standard: 1, enterprise: 2 };

// ── Feature Catalog ──

export interface FeatureDefinition {
  id: string;
  name: string;
  description: string;
  /** Default tier when no tier is specified */
  defaultTier: FeatureTier;
  /** Tier-gated sub-features (for UI display) */
  tiers?: Record<FeatureTier, string[]>;
}

export const FEATURE_CATALOG: FeatureDefinition[] = [
  {
    id: 'core',
    name: 'Core Commerce',
    description: 'Products, categories, orders, customers, branches, users, coupons',
    defaultTier: 'enterprise',
  },
  {
    id: 'loyalty',
    name: 'Loyalty Program',
    description: 'Points, earning rules, tiers, referrals, redemption',
    defaultTier: 'standard',
    tiers: {
      basic: ['earn_points', 'member_management'],
      standard: ['earn_points', 'member_management', 'earning_rules', 'tiers', 'redemption'],
      enterprise: [
        'earn_points',
        'member_management',
        'earning_rules',
        'tiers',
        'redemption',
        'referrals',
        'analytics',
      ],
    },
  },
  {
    id: 'pos',
    name: 'Point of Sale',
    description: 'In-store POS terminal with barcode scanning',
    defaultTier: 'standard',
    tiers: {
      basic: ['sales', 'cash_payment'],
      standard: ['sales', 'cash_payment', 'multi_payment', 'loyalty_integration', 'receipt'],
      enterprise: [
        'sales',
        'cash_payment',
        'multi_payment',
        'loyalty_integration',
        'receipt',
        'offline_mode',
        'multi_terminal',
      ],
    },
  },
  {
    id: 'inventory',
    name: 'Inventory Management',
    description: 'Stock management, transfers, requests, purchases',
    defaultTier: 'standard',
    tiers: {
      basic: ['stock_view', 'adjustments'],
      standard: ['stock_view', 'adjustments', 'transfers', 'requests', 'purchases', 'movements'],
      enterprise: ['stock_view', 'adjustments', 'transfers', 'requests', 'purchases', 'movements', 'low_stock_alerts'],
    },
  },
  {
    id: 'warehouse',
    name: 'Warehouse Management',
    description: 'Advanced WMS — lots, packages, procurement, replenishment',
    defaultTier: 'standard',
    tiers: {
      basic: ['nodes', 'locations', 'audit'],
      standard: ['nodes', 'locations', 'audit', 'lots', 'packages', 'procurement', 'replenishment', 'cost'],
      enterprise: [
        'nodes',
        'locations',
        'audit',
        'lots',
        'packages',
        'procurement',
        'replenishment',
        'cost',
        'trace',
        'reports',
      ],
    },
  },
  {
    id: 'finance',
    name: 'Finance',
    description: 'Financial summaries, payment reconciliation',
    defaultTier: 'standard',
  },
  {
    id: 'accounting',
    name: 'Accounting',
    description: 'Chart of accounts, journal entries, trial balance',
    defaultTier: 'standard',
    tiers: {
      basic: ['chart_of_accounts'],
      standard: ['chart_of_accounts', 'journal_entries', 'posting'],
      enterprise: ['chart_of_accounts', 'journal_entries', 'posting', 'trial_balance', 'reports'],
    },
  },
  { id: 'orders', name: 'Order Operations', description: 'Quotations, RFQs, blanket orders, RMA workflow', defaultTier: 'standard' },
  { id: 'cms', name: 'CMS', description: 'Content pages', defaultTier: 'standard' },
  { id: 'media', name: 'Media Library', description: 'Image and asset management', defaultTier: 'standard' },
  {
    id: 'promotions',
    name: 'Promotions',
    description: 'Discounts, vouchers, programs, BOGO rules',
    defaultTier: 'standard',
  },
  { id: 'logistics', name: 'Logistics', description: 'Shipping providers, delivery zones', defaultTier: 'standard' },
  { id: 'analytics', name: 'Analytics', description: 'Dashboard analytics, reports', defaultTier: 'standard' },
  { id: 'export', name: 'Data Export', description: 'CSV, Excel export', defaultTier: 'standard' },
];

const FEATURE_IDS = FEATURE_CATALOG.map((f) => f.id);

// ── Resolved Feature State ──

export type PlanStatus = 'trial' | 'pro' | 'enterprise' | 'expired';

export type FeatureStatus = 'active' | 'trial' | 'disabled' | 'expired' | 'upgrade_required';

export interface PlanInfo {
  status: PlanStatus;
  name: string;
  expiresAt: string | null;
  daysRemaining: number;
}

export interface ResolvedFeature {
  id: string;
  enabled: boolean;
  status: FeatureStatus;
  tier: FeatureTier;
  capabilities: string[];
}

// ── Parser ──

function parseEnabledFeatures(): Map<string, FeatureTier> {
  const raw = process.env.ENABLED_FEATURES;
  if (!raw) {
    // Dev mode — all features at enterprise
    const map = new Map<string, FeatureTier>();
    for (const f of FEATURE_IDS) map.set(f, 'enterprise');
    return map;
  }

  const map = new Map<string, FeatureTier>();
  map.set('core', 'enterprise'); // Always included

  for (const entry of raw.split(',')) {
    const [id, tierStr] = entry.trim().toLowerCase().split(':');
    if (!FEATURE_IDS.includes(id)) continue;

    const tier = (TIERS.includes(tierStr as FeatureTier) ? tierStr : undefined) as FeatureTier | undefined;
    const def = FEATURE_CATALOG.find((f) => f.id === id);
    map.set(id, tier || def?.defaultTier || 'standard');
  }

  return map;
}

let _features: Map<string, FeatureTier> | null = null;

function getFeatureMap(): Map<string, FeatureTier> {
  if (!_features) _features = parseEnabledFeatures();
  return _features;
}

// ── Public API ──

export function isFeatureEnabled(featureId: string): boolean {
  return getFeatureMap().has(featureId);
}

export function getFeatureTier(featureId: string): FeatureTier | null {
  return getFeatureMap().get(featureId) || null;
}

export function meetsMinTier(featureId: string, minTier: FeatureTier): boolean {
  const tier = getFeatureTier(featureId);
  if (!tier) return false;
  return TIER_RANK[tier] >= TIER_RANK[minTier];
}

/**
 * Get plan info from env.
 * PLAN_STATUS=trial|pro|enterprise (default: trial for dev, pro for production)
 * PLAN_EXPIRES_AT=2026-12-31 (optional ISO date)
 * PLAN_NAME=BigBoss Pro (optional display name)
 */
function getPlanInfo(): PlanInfo {
  const status = (process.env.PLAN_STATUS || 'trial') as PlanStatus;
  const expiresAt = process.env.PLAN_EXPIRES_AT || null;
  const name = process.env.PLAN_NAME || (status === 'trial' ? 'Trial' : status === 'pro' ? 'Pro' : 'Enterprise');

  let daysRemaining = -1;
  if (expiresAt) {
    const ms = new Date(expiresAt).getTime() - Date.now();
    daysRemaining = Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
  }

  return { status, name, expiresAt, daysRemaining };
}

/**
 * Returns the full manifest for the frontend.
 */
export function getFeatureManifest(): { plan: PlanInfo; features: ResolvedFeature[]; enabled: string[] } {
  const map = getFeatureMap();
  const plan = getPlanInfo();
  const features: ResolvedFeature[] = [];

  for (const def of FEATURE_CATALOG) {
    const tier = map.get(def.id);
    const enabled = !!tier;
    const resolvedTier = tier || def.defaultTier;
    const capabilities = enabled && def.tiers ? def.tiers[resolvedTier] || [] : [];

    // Derive feature-level status from plan + enabled state
    let status: FeatureStatus = 'disabled';
    if (enabled) {
      status = plan.status === 'trial' ? 'trial' : 'active';
      if (plan.status === 'expired') status = 'expired';
    }

    features.push({ id: def.id, enabled, status, tier: resolvedTier, capabilities });
  }

  return {
    plan,
    features,
    enabled: [...map.keys()],
  };
}
