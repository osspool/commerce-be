/**
 * Targeted JE probe — minimal version that won't hang.
 * Confirms: TTL index, JE state, Invoice→JE mapping integrity.
 *
 * Run from be-prod/: node test/probe-je-targeted.mjs
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

// 1. Indexes on journalentries
console.log('\n=== JOURNALENTRIES INDEXES ===');
const idxs = await je.indexes();
for (const i of idxs) {
  const ttl = i.expireAfterSeconds;
  const partial = i.partialFilterExpression ? JSON.stringify(i.partialFilterExpression) : '';
  const flags = [ttl ? `TTL=${ttl}s` : '', partial ? `partial=${partial}` : '', i.unique ? 'unique' : '', i.sparse ? 'sparse' : ''].filter(Boolean).join(' ');
  console.log(' ', i.name, JSON.stringify(i.key), flags);
}

// 2. JE counts
console.log('\n=== JE STATE ===');
const total = await je.countDocuments({});
const withKey = await je.countDocuments({ idempotencyKey: { $type: 'string' } });
const withoutKey = await je.countDocuments({ idempotencyKey: { $exists: false } });
const withInvSourceModel = await je.countDocuments({ 'sourceRef.sourceModel': 'Invoice' });
const sources = await je.distinct('sourceRef.sourceModel');
console.log({ total, withIdempotencyKey: withKey, withoutKey, withInvSourceModel, distinctSourceModels: sources });

// 3. JE age distribution
console.log('\n=== JE AGE DISTRIBUTION ===');
const now = Date.now();
const buckets = { '<1h': 0, '1-6h': 0, '6-12h': 0, '12-24h': 0, '>24h': 0 };
const docs = await je.find({}, { projection: { createdAt: 1, idempotencyKey: 1 } }).toArray();
for (const d of docs) {
  const age = (now - new Date(d.createdAt).getTime()) / 3600000;
  const k = age < 1 ? '<1h' : age < 6 ? '1-6h' : age < 12 ? '6-12h' : age < 24 ? '12-24h' : '>24h';
  buckets[k]++;
}
console.log({ buckets, totalScanned: docs.length });

// 4. Invoice → JE mismatch
console.log('\n=== INVOICE→JE MAPPING ===');
const invsTotal = await inv.countDocuments({});
const invsWithJE = await inv.countDocuments({ journalEntryId: { $ne: null, $exists: true } });
console.log({ invoicesTotal: invsTotal, invoicesWithJournalEntryId: invsWithJE });

// Sample 5 invoices with journalEntryId, check if their JE actually exists
const sample = await inv.find({ journalEntryId: { $ne: null, $exists: true } }).project({ _id: 1, number: 1, moveType: 1, journalEntryId: 1, createdAt: 1 }).limit(5).toArray();
console.log('\nSample of 5 invoices:');
for (const i of sample) {
  // journalEntryId is stored as String per packages/invoice/src/models/invoice.model.ts:198
  const jeIdStr = i.journalEntryId;
  let found = false;
  if (jeIdStr) {
    try {
      const jeDoc = await je.findOne({ _id: mongoose.Types.ObjectId.isValid(jeIdStr) ? new mongoose.Types.ObjectId(jeIdStr) : jeIdStr });
      found = !!jeDoc;
    } catch { /* ignore */ }
  }
  const ageH = ((now - new Date(i.createdAt).getTime()) / 3600000).toFixed(1);
  console.log(`  ${i.number} (${i.moveType}, ${ageH}h old) → ${jeIdStr} ${found ? '✓ EXISTS' : '✗ MISSING'}`);
}

// 5. Count orphans systematically
console.log('\n=== ORPHAN COUNT ===');
let orphans = 0, healthy = 0;
const allInvsWithJE = await inv.find({ journalEntryId: { $ne: null, $exists: true } }).project({ journalEntryId: 1 }).toArray();
for (const i of allInvsWithJE) {
  if (!i.journalEntryId) continue;
  const id = mongoose.Types.ObjectId.isValid(i.journalEntryId) ? new mongoose.Types.ObjectId(i.journalEntryId) : i.journalEntryId;
  const exists = await je.countDocuments({ _id: id }, { limit: 1 });
  if (exists) healthy++; else orphans++;
}
console.log({ orphanedInvoices: orphans, healthyInvoices: healthy });

await mongoose.disconnect();
console.log('\n=== Done ===');
