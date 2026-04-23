/**
 * Bootstrap Deployment
 *
 * One-shot seeding for a fresh commerce-os install. Takes a single JSON
 * config (see `scripts/bootstrap.example.json`) and provisions:
 *
 *   1. Admin user (Better Auth signup + superadmin role)
 *   2. Branches (Better Auth organizations + branch metadata)
 *   3. Chart of accounts (country pack via accountRepository.seedAccounts)
 *   4. Fiscal periods (annual / quarterly / monthly)
 *   5. PlatformConfig singleton (payment methods, logistics, vat, membership, checkout)
 *
 * Usage:
 *   tsx scripts/bootstrap-deployment.ts [path/to/config.json]
 *
 * Defaults to `./scripts/bootstrap.config.json`. Copy
 * `bootstrap.example.json` to that path, edit for your deployment, then run.
 *
 * Idempotency: safe to re-run — existing users/branches/accounts/periods
 * are detected and skipped. PlatformConfig is deep-merged.
 */
import '../src/config/env-loader.js';

import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { MongoClient, ObjectId } from 'mongodb';
import { getAuth } from '../src/resources/auth/auth.config.js';
import { accountRepository, FiscalPeriod } from '../src/resources/accounting/accounting.engine.js';
import PlatformConfig from '../src/resources/platform/platform.model.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface BranchInput {
  name: string;
  slug: string;
  code: string;
  role: 'head_office' | 'sub_branch';
  branchType: 'warehouse' | 'store' | 'hybrid';
  isDefault?: boolean;
  phone?: string;
}

interface FiscalYearInput {
  year: number;
  /** 1-12, month the fiscal year begins. Default: 1 (calendar year) */
  startMonth?: number;
  /** How to slice the fiscal year into periods */
  periods?: 'monthly' | 'quarterly' | 'annual';
}

interface BootstrapInput {
  admin: { name: string; email: string; password: string };
  branches: BranchInput[];
  accounting?: {
    seedCOA?: boolean;
    fiscalYear?: FiscalYearInput;
  };
  platformConfig?: Record<string, unknown>;
}

interface SeedSummary {
  adminUserId?: string;
  createdBranches: Array<{ name: string; code: string; organizationId: string; isDefault: boolean }>;
  skippedBranches: Array<{ name: string; code: string }>;
  accountsSeeded: number;
  accountsSkipped: boolean;
  fiscalPeriodsCreated: number;
  fiscalPeriodsSkipped: number;
  platformConfigApplied: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function log(msg: string): void {
  console.log(msg);
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

async function loadConfig(): Promise<BootstrapInput> {
  const configPath = process.argv[2] || path.join(process.cwd(), 'scripts', 'bootstrap.config.json');
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    return JSON.parse(raw) as BootstrapInput;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      console.error(
        `[bootstrap] Config not found at ${configPath}. Copy scripts/bootstrap.example.json and edit for your deployment.`,
      );
    }
    throw err;
  }
}

function dateUTC(year: number, monthIdx: number, day: number): Date {
  return new Date(Date.UTC(year, monthIdx, day, 0, 0, 0, 0));
}

function endOfMonthUTC(year: number, monthIdx: number): Date {
  return new Date(Date.UTC(year, monthIdx + 1, 0, 23, 59, 59, 999));
}

function buildFiscalPeriods(input: FiscalYearInput): Array<{ name: string; startDate: Date; endDate: Date }> {
  const startMonth = (input.startMonth ?? 1) - 1; // 0-indexed
  const year = input.year;
  const mode = input.periods ?? 'quarterly';
  const periods: Array<{ name: string; startDate: Date; endDate: Date }> = [];

  const monthName = (m: number) =>
    ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m];

  if (mode === 'annual') {
    const start = dateUTC(year, startMonth, 1);
    const endMonthIdx = (startMonth + 11) % 12;
    const endYear = startMonth === 0 ? year : year + 1;
    const end = endOfMonthUTC(endYear, endMonthIdx);
    periods.push({ name: `FY${year}`, startDate: start, endDate: end });
  } else if (mode === 'quarterly') {
    for (let q = 0; q < 4; q++) {
      const qStartMonthIdx = (startMonth + q * 3) % 12;
      const qYear = startMonth + q * 3 >= 12 ? year + 1 : year;
      const start = dateUTC(qYear, qStartMonthIdx, 1);
      const qEndMonthIdx = (qStartMonthIdx + 2) % 12;
      const qEndYear = qStartMonthIdx + 2 >= 12 ? qYear + 1 : qYear;
      const end = endOfMonthUTC(qEndYear, qEndMonthIdx);
      periods.push({ name: `FY${year}-Q${q + 1}`, startDate: start, endDate: end });
    }
  } else {
    // monthly
    for (let m = 0; m < 12; m++) {
      const monthIdx = (startMonth + m) % 12;
      const monthYear = startMonth + m >= 12 ? year + 1 : year;
      const start = dateUTC(monthYear, monthIdx, 1);
      const end = endOfMonthUTC(monthYear, monthIdx);
      periods.push({ name: `FY${year}-${monthName(monthIdx)}`, startDate: start, endDate: end });
    }
  }

  return periods;
}

// ─── Steps ──────────────────────────────────────────────────────────────────

async function seedAdminUser(
  input: BootstrapInput,
  db: import('mongodb').Db,
  auth: { api: any },
): Promise<{ userId: string; sessionToken: string }> {
  const existing = await db.collection('user').findOne({ email: input.admin.email });
  if (existing) {
    log(`[admin] exists: ${input.admin.email} — reusing`);
    // Try to sign in to get a session token. If this fails the script can't
    // create branches with this user, but the install is not broken.
    const signIn = await auth.api.signInEmail({
      body: { email: input.admin.email, password: input.admin.password },
    });
    return { userId: String(existing._id), sessionToken: signIn.token };
  }

  log(`[admin] creating: ${input.admin.email}`);
  const ctx = await auth.api.signUpEmail({
    body: {
      name: input.admin.name,
      email: input.admin.email,
      password: input.admin.password,
    },
  });

  await db.collection('user').updateOne(
    { _id: new ObjectId(ctx.user.id) },
    { $set: { role: ['superadmin', 'admin'], isActive: true } },
  );

  return { userId: ctx.user.id, sessionToken: ctx.token };
}

async function seedBranches(
  input: BootstrapInput,
  db: import('mongodb').Db,
  auth: { api: any },
  sessionToken: string,
  summary: SeedSummary,
): Promise<void> {
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${sessionToken}`);

  for (const branch of input.branches) {
    const existing = await db.collection('organization').findOne({ slug: branch.slug });
    if (existing) {
      log(`[branch] exists: ${branch.name} (${branch.code}) — skipping`);
      summary.skippedBranches.push({ name: branch.name, code: branch.code });
      continue;
    }

    log(`[branch] creating: ${branch.name} (${branch.code})`);
    const result = await auth.api.createOrganization({
      body: {
        name: branch.name,
        slug: branch.slug,
        metadata: {
          code: branch.code,
          branchType: branch.branchType,
          branchRole: branch.role,
        },
      },
      headers,
    });

    await db.collection('organization').updateOne(
      { _id: new ObjectId(result.id) },
      {
        $set: {
          code: branch.code,
          branchType: branch.branchType,
          branchRole: branch.role,
          isDefault: !!branch.isDefault,
          isActive: true,
          ...(branch.phone ? { phone: branch.phone } : {}),
        },
      },
    );

    summary.createdBranches.push({
      name: branch.name,
      code: branch.code,
      organizationId: result.id,
      isDefault: !!branch.isDefault,
    });
  }

  // Set active org to the default (or first) branch
  const preferred = input.branches.find((b) => b.isDefault) ?? input.branches[0];
  if (preferred) {
    const org = await db.collection('organization').findOne({ slug: preferred.slug });
    if (org) {
      await auth.api.setActiveOrganization({
        body: { organizationId: String(org._id) },
        headers,
      });
      log(`[branch] active organization set to ${preferred.name}`);
    }
  }
}

async function seedChartOfAccounts(input: BootstrapInput, summary: SeedSummary): Promise<void> {
  if (!input.accounting?.seedCOA) {
    log('[coa] skipped (accounting.seedCOA=false)');
    summary.accountsSkipped = true;
    return;
  }

  const result = await accountRepository.seedAccounts(undefined);
  const created = (result as { created?: number }).created ?? 0;
  const skipped = (result as { skipped?: number }).skipped ?? 0;

  if (created === 0) {
    log(`[coa] already seeded (skipped=${skipped})`);
    summary.accountsSkipped = true;
    return;
  }

  log(`[coa] seeded ${created} accounts (skipped=${skipped})`);
  summary.accountsSeeded = created;
}

async function seedFiscalPeriods(input: BootstrapInput, summary: SeedSummary): Promise<void> {
  const fy = input.accounting?.fiscalYear;
  if (!fy) {
    log('[fiscal] skipped (no accounting.fiscalYear config)');
    return;
  }

  const periods = buildFiscalPeriods(fy);
  for (const p of periods) {
    const existing = await FiscalPeriod.findOne({ name: p.name });
    if (existing) {
      log(`[fiscal] exists: ${p.name} — skipping`);
      summary.fiscalPeriodsSkipped++;
      continue;
    }
    await FiscalPeriod.create({ ...p, closed: false });
    log(`[fiscal] created: ${p.name} (${p.startDate.toISOString().slice(0, 10)} → ${p.endDate.toISOString().slice(0, 10)})`);
    summary.fiscalPeriodsCreated++;
  }
}

async function applyPlatformConfig(input: BootstrapInput, summary: SeedSummary): Promise<void> {
  if (!input.platformConfig) {
    log('[platform] skipped (no platformConfig block)');
    return;
  }

  await (PlatformConfig as unknown as { updateConfig: (u: Record<string, unknown>) => Promise<unknown> }).updateConfig(
    input.platformConfig,
  );

  log('[platform] config applied (payment methods, logistics, vat, membership, checkout)');
  summary.platformConfigApplied = true;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const input = await loadConfig();
  const mongoUri = mustEnv('MONGO_URI');

  log('[boot] connecting to MongoDB');
  await mongoose.connect(mongoUri);
  const native = new MongoClient(mongoUri);
  await native.connect();
  const db = native.db();

  const auth = getAuth() as unknown as { api: any };

  const summary: SeedSummary = {
    createdBranches: [],
    skippedBranches: [],
    accountsSeeded: 0,
    accountsSkipped: false,
    fiscalPeriodsCreated: 0,
    fiscalPeriodsSkipped: 0,
    platformConfigApplied: false,
  };

  try {
    const { userId, sessionToken } = await seedAdminUser(input, db, auth);
    summary.adminUserId = userId;

    await seedBranches(input, db, auth, sessionToken, summary);
    await seedChartOfAccounts(input, summary);
    await seedFiscalPeriods(input, summary);
    await applyPlatformConfig(input, summary);
  } finally {
    await native.close();
    await mongoose.disconnect();
  }

  log('\n' + '='.repeat(60));
  log('Bootstrap complete');
  log('='.repeat(60));
  log(`Admin user: ${input.admin.email} (${summary.adminUserId ?? 'unknown'})`);
  log(`Branches created: ${summary.createdBranches.length}, skipped: ${summary.skippedBranches.length}`);
  for (const b of summary.createdBranches) {
    log(`  + ${b.name} [${b.code}] ${b.isDefault ? '(default)' : ''} — ${b.organizationId}`);
  }
  for (const b of summary.skippedBranches) {
    log(`  = ${b.name} [${b.code}] already existed`);
  }
  log(`Chart of accounts: ${summary.accountsSkipped ? 'already seeded' : `${summary.accountsSeeded} accounts`}`);
  log(`Fiscal periods: created=${summary.fiscalPeriodsCreated}, skipped=${summary.fiscalPeriodsSkipped}`);
  log(`PlatformConfig: ${summary.platformConfigApplied ? 'applied' : 'skipped'}`);
}

main().catch((err) => {
  console.error('[bootstrap] failed:', err);
  process.exit(1);
});
