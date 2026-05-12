/**
 * Feature + tier gating — reads from deployment.config.ts (committed, git-tracked).
 *
 * To enable/disable features for a deployment, edit deployment.config.ts at the
 * repo root — do NOT set ENABLED_FEATURES env. The config file is the contract.
 *
 * Tiers (ordered lowest → highest):  basic < standard < enterprise
 */

import deploymentConfig from '../deployment.config.js';

// ── Tier Definitions ──────────────────────────────────────────────────────────

export const TIERS = ['basic', 'standard', 'enterprise'] as const;
export type FeatureTier = (typeof TIERS)[number];

const TIER_RANK: Record<FeatureTier, number> = { basic: 0, standard: 1, enterprise: 2 };

// ── Feature Catalog ───────────────────────────────────────────────────────────

export interface FeatureDefinition {
  id: string;
  name: string;
  description: string;
  defaultTier: FeatureTier;
  /** Tier-gated sub-capabilities (for UI display via /platform/features) */
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
      enterprise: ['earn_points', 'member_management', 'earning_rules', 'tiers', 'redemption', 'referrals', 'analytics'],
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
      enterprise: ['sales', 'cash_payment', 'multi_payment', 'loyalty_integration', 'receipt', 'offline_mode', 'multi_terminal'],
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
      enterprise: ['nodes', 'locations', 'audit', 'lots', 'packages', 'procurement', 'replenishment', 'cost', 'trace', 'reports'],
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
  {
    id: 'crm',
    name: 'CRM',
    description: 'Pipelines, opportunities, contacts, accounts, activities',
    defaultTier: 'standard',
    tiers: {
      basic: ['contacts', 'accounts'],
      standard: ['contacts', 'accounts', 'pipelines', 'opportunities', 'activities', 'notes'],
      enterprise: ['contacts', 'accounts', 'pipelines', 'opportunities', 'activities', 'notes', 'analytics', 'automation'],
    },
  },
];

const FEATURE_IDS = new Set(FEATURE_CATALOG.map((f) => f.id));

// ── Feature Map — built once at module load from deployment.config.ts ─────────

function buildFeatureMap(): Map<string, FeatureTier> {
  const map = new Map<string, FeatureTier>();

  for (const [id, tier] of Object.entries(deploymentConfig)) {
    if (!FEATURE_IDS.has(id)) {
      console.warn(`[features] Unknown feature "${id}" in deployment.config.ts — skipped`);
      continue;
    }
    if (!TIERS.includes(tier as FeatureTier)) {
      console.warn(`[features] Invalid tier "${tier}" for feature "${id}" — defaulting to standard`);
      map.set(id, 'standard');
      continue;
    }
    map.set(id, tier as FeatureTier);
  }

  // core is always-on; enforce even if accidentally omitted from config
  if (!map.has('core')) map.set('core', 'enterprise');

  return map;
}

const _featureMap: Map<string, FeatureTier> = buildFeatureMap();

// ── Public API ────────────────────────────────────────────────────────────────

export function isFeatureEnabled(featureId: string): boolean {
  return _featureMap.has(featureId);
}

export function getFeatureTier(featureId: string): FeatureTier | null {
  return _featureMap.get(featureId) ?? null;
}

export function meetsMinTier(featureId: string, minTier: FeatureTier): boolean {
  const tier = getFeatureTier(featureId);
  if (!tier) return false;
  return TIER_RANK[tier] >= TIER_RANK[minTier];
}

// ── Plan info (license display — separate from feature config) ────────────────

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

function getPlanInfo(): PlanInfo {
  const status = (process.env.PLAN_STATUS || 'pro') as PlanStatus;
  const expiresAt = process.env.PLAN_EXPIRES_AT || null;
  const name = process.env.PLAN_NAME || (status === 'trial' ? 'Trial' : status === 'pro' ? 'Pro' : 'Enterprise');

  let daysRemaining = -1;
  if (expiresAt) {
    const ms = new Date(expiresAt).getTime() - Date.now();
    daysRemaining = Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
  }

  return { status, name, expiresAt, daysRemaining };
}

/** Full manifest returned by GET /platform/features — consumed by the frontend. */
export function getFeatureManifest(): { plan: PlanInfo; features: ResolvedFeature[]; enabled: string[] } {
  const plan = getPlanInfo();
  const features: ResolvedFeature[] = [];

  for (const def of FEATURE_CATALOG) {
    const tier = _featureMap.get(def.id);
    const enabled = !!tier;
    const resolvedTier = tier ?? def.defaultTier;
    const capabilities = enabled && def.tiers ? def.tiers[resolvedTier] ?? [] : [];

    let status: FeatureStatus = 'disabled';
    if (enabled) {
      status = plan.status === 'trial' ? 'trial' : 'active';
      if (plan.status === 'expired') status = 'expired';
    }

    features.push({ id: def.id, enabled, status, tier: resolvedTier, capabilities });
  }

  return { plan, features, enabled: [..._featureMap.keys()] };
}
