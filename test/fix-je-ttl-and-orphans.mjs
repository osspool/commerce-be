/**
 * One-shot fix:
 *   1. Drop the obsolete `idempotency_ttl_idx` from journalentries.
 *      (The schema no longer creates it; this drops the residue from
 *       installs that picked up the old shape.)
 *   2. Recreate journal entries for the 28 orphaned Invoice docs whose
 *      `journalEntryId` references a JE the TTL deleted.
 *
 * SAFE-ISH: drops one explicit index by name, only writes JEs the
 * Invoice rows say should exist. Idempotent — re-running it after a
 * clean run is a no-op (orphan count = 0).
 *
 * Run from be-prod/: node test/fix-je-ttl-and-orphans.mjs
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '..', '.env.dev'), override: true });

const URI = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!URI) { console.error('Missing MONGO_URI'); process.exit(1); }

await mongoose.connect(URI, { serverSelectionTimeoutMS: 15000 });
const db = mongoose.connection.db;

const je = db.collection('journalentries');
const inv = db.collection('invoices');
const accounts = db.collection('accounts');
const fiscalPeriods = db.collection('fiscalperiods');

// ─── Step 1: drop the TTL index ──────────────────────────────────────
console.log('\n=== STEP 1: Drop idempotency_ttl_idx ===');
try {
  await je.dropIndex('idempotency_ttl_idx');
  console.log('✓ Dropped idempotency_ttl_idx');
} catch (err) {
  if (err.codeName === 'IndexNotFound' || /index not found/i.test(err.message ?? '')) {
    console.log('  (not present — nothing to drop)');
  } else {
    throw err;
  }
}

// ─── Step 2: build account-code → ObjectId map ───────────────────────
console.log('\n=== STEP 2: Load chart-of-accounts ===');
const accDocs = await accounts.find({}).project({ _id: 1, accountTypeCode: 1, accountNumber: 1 }).toArray();
const accByCode = new Map();
for (const a of accDocs) {
  if (a.accountTypeCode) accByCode.set(String(a.accountTypeCode), a._id);
}
console.log(`  loaded ${accByCode.size} accounts`);

// BD chart-of-account codes (mirrors @classytic/ledger-bd BD_ACCOUNT_CODES)
const ACCOUNTS = {
  receivable: '1141',          // Accounts Receivable (Trade Debtors)
  payable: '2111',             // Accounts Payable (Trade Creditors)
  revenue: '4111',             // Sales — Domestic
  expense: '5111',             // Cost of Goods Sold (Materials)
  taxPayable: '2132',          // VAT Output Payable
  taxReceivable: '1175',       // VAT Receivable
  cash: '1113',                // Cash at Bank — Current Account
};
const acctId = (code) => {
  const id = accByCode.get(code);
  if (!id) throw new Error(`Account code ${code} not seeded`);
  return id;
};

// ─── Step 3: orphan detection ────────────────────────────────────────
console.log('\n=== STEP 3: Find orphaned invoices ===');
const candidates = await inv
  .find({ journalEntryId: { $ne: null, $exists: true }, status: { $in: ['posted', 'paid', 'partially_paid', 'cancelled'] } })
  .project({ _id: 1, number: 1, moveType: 1, partnerId: 1, partnerName: 1, organizationId: 1, date: 1, currency: 1, lines: 1, totalAmount: 1, taxAmount: 1, untaxedAmount: 1, journalEntryId: 1, postedAt: 1, idempotencyKey: 1, status: 1 })
  .toArray();

const orphans = [];
for (const c of candidates) {
  if (!c.journalEntryId) continue;
  const id = mongoose.Types.ObjectId.isValid(c.journalEntryId) ? new mongoose.Types.ObjectId(c.journalEntryId) : c.journalEntryId;
  const exists = await je.countDocuments({ _id: id }, { limit: 1 });
  if (!exists) orphans.push(c);
}
console.log(`  candidates: ${candidates.length}, orphans: ${orphans.length}`);

// ─── Step 4: rebuild orphaned JEs ────────────────────────────────────
console.log('\n=== STEP 4: Rebuild orphaned JEs ===');

function buildLines(invDoc) {
  const moveType = invDoc.moveType;
  const customerSide = moveType === 'out_invoice' || moveType === 'out_refund' || moveType === 'receipt';
  const refund = moveType === 'out_refund' || moveType === 'in_refund';

  const balanceSheetAccount = customerSide ? ACCOUNTS.receivable : ACCOUNTS.payable;
  const incomeOrExpenseAccount = customerSide ? ACCOUNTS.revenue : ACCOUNTS.expense;
  const taxAccount = customerSide ? ACCOUNTS.taxPayable : ACCOUNTS.taxReceivable;

  const lines = [];

  if (customerSide && !refund) {
    lines.push({ account: acctId(balanceSheetAccount), debit: invDoc.totalAmount, credit: 0, label: `Invoice ${invDoc._id}`, partnerId: invDoc.partnerId, partnerType: 'customer', date: invDoc.date });
    for (const l of (invDoc.lines || [])) {
      lines.push({ account: acctId(incomeOrExpenseAccount), debit: 0, credit: l.subtotal, label: l.description, date: invDoc.date });
    }
    if (invDoc.taxAmount > 0) lines.push({ account: acctId(taxAccount), debit: 0, credit: invDoc.taxAmount, label: 'Tax', date: invDoc.date });
  } else if (customerSide && refund) {
    lines.push({ account: acctId(balanceSheetAccount), debit: 0, credit: invDoc.totalAmount, label: `Credit Note ${invDoc._id}`, partnerId: invDoc.partnerId, partnerType: 'customer', date: invDoc.date });
    for (const l of (invDoc.lines || [])) {
      lines.push({ account: acctId(incomeOrExpenseAccount), debit: l.subtotal, credit: 0, label: l.description, date: invDoc.date });
    }
    if (invDoc.taxAmount > 0) lines.push({ account: acctId(taxAccount), debit: invDoc.taxAmount, credit: 0, label: 'Tax reversal', date: invDoc.date });
  } else if (!customerSide && !refund) {
    // Vendor Bill (in_invoice)
    for (const l of (invDoc.lines || [])) {
      lines.push({ account: acctId(incomeOrExpenseAccount), debit: l.subtotal, credit: 0, label: l.description, date: invDoc.date });
    }
    if (invDoc.taxAmount > 0) lines.push({ account: acctId(taxAccount), debit: invDoc.taxAmount, credit: 0, label: 'Tax', date: invDoc.date });
    lines.push({ account: acctId(balanceSheetAccount), debit: 0, credit: invDoc.totalAmount, label: `Bill ${invDoc._id}`, partnerId: invDoc.partnerId, partnerType: 'supplier', date: invDoc.date });
  } else {
    // Vendor Credit Note (in_refund)
    lines.push({ account: acctId(balanceSheetAccount), debit: invDoc.totalAmount, credit: 0, label: `Vendor Credit ${invDoc._id}`, partnerId: invDoc.partnerId, partnerType: 'supplier', date: invDoc.date });
    for (const l of (invDoc.lines || [])) {
      lines.push({ account: acctId(incomeOrExpenseAccount), debit: 0, credit: l.subtotal, label: l.description, date: invDoc.date });
    }
    if (invDoc.taxAmount > 0) lines.push({ account: acctId(taxAccount), debit: 0, credit: invDoc.taxAmount, label: 'Tax reversal', date: invDoc.date });
  }

  return lines;
}

const JOURNAL_TYPE_MAP = { out_invoice: 'SALES', in_invoice: 'PURCHASES', out_refund: 'SALES', in_refund: 'PURCHASES', receipt: 'CASH_RECEIPTS' };

let recovered = 0, failed = 0;
for (const o of orphans) {
  try {
    const lines = buildLines(o);
    if (!lines.length) { failed++; continue; }

    // Validate balance
    const totalD = lines.reduce((s, l) => s + (l.debit || 0), 0);
    const totalC = lines.reduce((s, l) => s + (l.credit || 0), 0);
    if (totalD !== totalC) {
      console.warn(`  ! ${o.number}: imbalance D=${totalD} C=${totalC} — skipping`);
      failed++; continue;
    }

    const newId = new mongoose.Types.ObjectId();
    const doc = {
      _id: newId,
      journalType: JOURNAL_TYPE_MAP[o.moveType] ?? 'GENERAL',
      label: `${o.moveType} ${o._id}`,
      date: o.date,
      journalItems: lines,
      state: 'posted',
      reversed: false,
      organizationId: o.organizationId,
      sourceRef: { sourceModel: 'Invoice', sourceId: String(o._id) },
      // No idempotencyKey on rebuild — these are recovery JEs, not replays
      totalDebit: totalD,
      totalCredit: totalC,
      createdAt: o.postedAt || o.date || new Date(),
      updatedAt: new Date(),
      __v: 0,
    };

    await je.insertOne(doc);
    await inv.updateOne({ _id: o._id }, { $set: { journalEntryId: String(newId) } });
    console.log(`  ✓ ${o.number} (${o.moveType}) → ${newId}`);
    recovered++;
  } catch (err) {
    console.warn(`  ! ${o.number}: ${err.message}`);
    failed++;
  }
}

console.log(`\nrecovered: ${recovered}, failed: ${failed}`);

// ─── Step 5: re-verify ───────────────────────────────────────────────
console.log('\n=== STEP 5: Re-verify ===');
let stillOrphan = 0;
for (const c of candidates) {
  if (!c.journalEntryId) continue;
  const fresh = await inv.findOne({ _id: c._id }, { projection: { journalEntryId: 1 } });
  if (!fresh?.journalEntryId) continue;
  const id = mongoose.Types.ObjectId.isValid(fresh.journalEntryId) ? new mongoose.Types.ObjectId(fresh.journalEntryId) : fresh.journalEntryId;
  const exists = await je.countDocuments({ _id: id }, { limit: 1 });
  if (!exists) stillOrphan++;
}
console.log(`  remaining orphans: ${stillOrphan}`);

// Verify TTL index is truly gone
const idxs = await je.indexes();
const ttl = idxs.find((i) => i.expireAfterSeconds !== undefined);
console.log(`  TTL index on journalentries: ${ttl ? 'STILL PRESENT — ' + ttl.name : 'GONE'}`);

await mongoose.disconnect();
console.log('\n=== Done ===');
