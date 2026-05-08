/**
 * Probe: Where did the Invoice-bridge JEs go?
 *
 * The Invoice docs in MongoDB carry `journalEntryId` ObjectIds, but those JEs
 * don't appear in the JournalEntry collection through the be-prod API.
 *
 * READ-ONLY. Does no writes.
 *
 * Run from `d:/projects/ecom/commerce/`:
 *     node be-prod/test/probe-je-mystery.mjs
 *
 * (Or from `d:/projects/ecom/commerce/be-prod/`:
 *     node test/probe-je-mystery.mjs )
 *
 * What it does:
 *   1. Loads .env.dev → MONGO_URI / MONGODB_URI
 *   2. Connects with mongoose
 *   3. Lists all collections + counts (highlights journal/ledger/entry names)
 *   4. Hunts for three suspect JE IDs across EVERY collection
 *   5. Compares invoices.journalEntryId vs journalentries.sourceRef.sourceModel='Invoice'
 *   6. Reports indexes on journalentries (TTL / partial-filter / soft-delete)
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// dotenv/config picked up `.env` in cwd — but we want `.env.dev` from be-prod/
const envCandidates = [
  resolve(__dirname, '../.env.dev'),
  resolve(__dirname, '../.env'),
  resolve(process.cwd(), 'be-prod/.env.dev'),
  resolve(process.cwd(), 'be-prod/.env'),
  resolve(process.cwd(), '.env.dev'),
  resolve(process.cwd(), '.env'),
];
for (const p of envCandidates) {
  if (existsSync(p)) {
    loadEnv({ path: p, override: false });
  }
}

const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!uri) {
  console.error('No MONGO_URI / MONGODB_URI found. Tried:', envCandidates);
  process.exit(1);
}

// Mask creds in printout
function safeUri(u) {
  return u.replace(/:\/\/([^@:]+):([^@]+)@/, '://$1:***@');
}

console.log('='.repeat(80));
console.log('JE Mystery Probe — READ ONLY');
console.log('='.repeat(80));
console.log('URI:', safeUri(uri));

const SUSPECT_IDS = [
  { id: '69f069cb27708791500a699b', label: 'JE for INV-2026-00019' },
  { id: '69f069bb27708791500a6998', label: 'JE for BILL-2026-00009' },
  { id: '69f0699127708791500a6988', label: 'JE for INV-2026-00018' },
];

await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
const db = mongoose.connection.db;
console.log('Connected. Database:', mongoose.connection.name);
console.log();

// ─── 1. List ALL collections + counts ──────────────────────────────────────
console.log('─── COLLECTIONS ───────────────────────────────────────────────');
const collInfos = await db.listCollections().toArray();
const colls = collInfos.map((c) => c.name).sort();
console.log(`Found ${colls.length} collections.\n`);

const SUSPECT_REGEX = /journal|ledger|entry|account|invoice|bill|posting/i;

const allCounts = [];
for (const name of colls) {
  // estimatedDocumentCount is fast; OK on read-only probe
  let count;
  try {
    count = await db.collection(name).estimatedDocumentCount();
  } catch (err) {
    count = `(err: ${err.message})`;
  }
  allCounts.push({ name, count });
}

const suspectCounts = allCounts.filter((c) => SUSPECT_REGEX.test(c.name));
const otherCounts = allCounts.filter((c) => !SUSPECT_REGEX.test(c.name));

console.log('Suspect collections (journal|ledger|entry|account|invoice|bill|posting):');
for (const { name, count } of suspectCounts) {
  console.log(`  ${name.padEnd(50)} ${String(count).padStart(8)}`);
}
console.log('\nAll other collections (count only):');
for (const { name, count } of otherCounts) {
  console.log(`  ${name.padEnd(50)} ${String(count).padStart(8)}`);
}
console.log();

// ─── 2. Hunt for the suspect IDs across EVERY collection ───────────────────
console.log('─── HUNT FOR SUSPECT IDs ──────────────────────────────────────');

function asObjectId(s) {
  try {
    return new mongoose.Types.ObjectId(s);
  } catch {
    return null;
  }
}

const matches = [];
for (const suspect of SUSPECT_IDS) {
  const oid = asObjectId(suspect.id);
  console.log(`\nSearching ${suspect.id} (${suspect.label})...`);
  if (!oid) {
    console.log('  Not a valid ObjectId, skipping.');
    continue;
  }
  for (const name of colls) {
    try {
      // Search _id field as ObjectId AND as string
      const queries = [
        { _id: oid },
        { _id: suspect.id },
      ];
      for (const q of queries) {
        const doc = await db.collection(name).findOne(q);
        if (doc) {
          matches.push({ collection: name, query: q, doc, suspect });
          console.log(`  HIT in '${name}' (query: ${JSON.stringify(q)})`);
        }
      }
    } catch {
      // ignore — may not be queryable shape
    }
  }
}

if (matches.length === 0) {
  console.log('\nNo direct _id matches found in any collection for any suspect ID.');
} else {
  console.log(`\n${matches.length} match(es) found:\n`);
  for (const m of matches) {
    console.log('─'.repeat(60));
    console.log(`Collection: ${m.collection}`);
    console.log(`Suspect:    ${m.suspect.id} (${m.suspect.label})`);
    console.log(`Doc dump:`);
    console.log(JSON.stringify(m.doc, null, 2));
  }
}
console.log();

// ─── 3. Mismatch scale: invoices.journalEntryId vs journalentries.sourceRef ──
console.log('─── MISMATCH SCALE ────────────────────────────────────────────');

async function safeCount(name, q) {
  try {
    return await db.collection(name).countDocuments(q);
  } catch (err) {
    return `(err: ${err.message})`;
  }
}

// Try every plausible JE collection name
const JE_COLLECTION_CANDIDATES = ['journalentries', 'journal_entries', 'journalEntries'];
const INVOICE_COLLECTION_CANDIDATES = ['invoices', 'invoice'];

const jeColl = JE_COLLECTION_CANDIDATES.find((n) => colls.includes(n));
const invColl = INVOICE_COLLECTION_CANDIDATES.find((n) => colls.includes(n));

console.log(`Detected JE collection:      ${jeColl ?? '(NONE FOUND)'}`);
console.log(`Detected Invoice collection: ${invColl ?? '(NONE FOUND)'}`);
console.log();

if (invColl) {
  const totalInvoices = await safeCount(invColl, {});
  const invWithJEId = await safeCount(invColl, { journalEntryId: { $ne: null, $exists: true } });
  const invWithoutJEId = await safeCount(invColl, {
    $or: [{ journalEntryId: null }, { journalEntryId: { $exists: false } }],
  });
  console.log(`invoices total docs:                    ${totalInvoices}`);
  console.log(`invoices with non-null journalEntryId:  ${invWithJEId}`);
  console.log(`invoices with null/missing journalEntryId: ${invWithoutJEId}`);

  // Sample 5 invoices with journalEntryId — check if those JE IDs exist anywhere
  if (typeof invWithJEId === 'number' && invWithJEId > 0) {
    console.log('\nSampling 5 invoices with journalEntryId set:');
    const sample = await db
      .collection(invColl)
      .find({ journalEntryId: { $ne: null, $exists: true } })
      .project({
        _id: 1,
        invoiceNumber: 1,
        moveType: 1,
        state: 1,
        journalEntryId: 1,
        organizationId: 1,
        createdAt: 1,
      })
      .limit(5)
      .toArray();
    for (const inv of sample) {
      console.log('  ', JSON.stringify(inv));
      // Look for the journalEntryId in the JE collection
      if (jeColl && inv.journalEntryId) {
        const jeId = inv.journalEntryId;
        const jeIdAsOid = asObjectId(String(jeId));
        const found = await db.collection(jeColl).findOne(
          jeIdAsOid ? { _id: jeIdAsOid } : { _id: jeId },
          { projection: { _id: 1, journalType: 1, state: 1, organizationId: 1, sourceRef: 1, deletedAt: 1 } },
        );
        console.log('    →  JE lookup result:', found ? JSON.stringify(found) : '(NOT FOUND in journalentries)');
      }
    }
  }
}

console.log();
if (jeColl) {
  const totalJEs = await safeCount(jeColl, {});
  const jeFromInvoice = await safeCount(jeColl, { 'sourceRef.sourceModel': 'Invoice' });
  const jeFromInvoiceWithSourceId = await safeCount(jeColl, {
    'sourceRef.sourceModel': 'Invoice',
    'sourceRef.sourceId': { $ne: null, $exists: true },
  });
  const jeWithNoSourceRef = await safeCount(jeColl, {
    $or: [{ sourceRef: null }, { 'sourceRef.sourceModel': null }, { sourceRef: { $exists: false } }],
  });
  console.log(`${jeColl} total docs:                              ${totalJEs}`);
  console.log(`${jeColl} sourceRef.sourceModel === 'Invoice':     ${jeFromInvoice}`);
  console.log(`${jeColl} above + sourceRef.sourceId set:          ${jeFromInvoiceWithSourceId}`);
  console.log(`${jeColl} with null/missing sourceRef:             ${jeWithNoSourceRef}`);

  // What sourceModel values exist?
  try {
    const distinct = await db.collection(jeColl).distinct('sourceRef.sourceModel');
    console.log(`${jeColl} distinct sourceRef.sourceModel values: ${JSON.stringify(distinct)}`);
  } catch (err) {
    console.log(`distinct sourceRef.sourceModel failed: ${err.message}`);
  }

  // What journalType values exist + their counts?
  try {
    const byType = await db
      .collection(jeColl)
      .aggregate([{ $group: { _id: '$journalType', n: { $sum: 1 } } }, { $sort: { n: -1 } }])
      .toArray();
    console.log(`${jeColl} by journalType:`);
    for (const t of byType) console.log(`    ${String(t._id).padEnd(40)} ${t.n}`);
  } catch (err) {
    console.log(`group-by journalType failed: ${err.message}`);
  }

  // What state values?
  try {
    const byState = await db
      .collection(jeColl)
      .aggregate([{ $group: { _id: '$state', n: { $sum: 1 } } }, { $sort: { n: -1 } }])
      .toArray();
    console.log(`${jeColl} by state:`);
    for (const s of byState) console.log(`    ${String(s._id).padEnd(40)} ${s.n}`);
  } catch (err) {
    console.log(`group-by state failed: ${err.message}`);
  }
}
console.log();

// ─── 4. Indexes on journalentries (TTL / partial / sparse / unique) ────────
console.log('─── INDEXES ON journalentries (look for TTL / partial / soft-delete) ───');
if (jeColl) {
  const indexes = await db.collection(jeColl).indexes();
  for (const idx of indexes) {
    console.log(JSON.stringify(idx));
  }
} else {
  console.log('(no JE collection detected)');
}
console.log();

// ─── 5. Sample 3 most-recent JE docs to see the actual schema ──────────────
console.log('─── 3 MOST-RECENT JE DOCS (schema sanity) ─────────────────────');
if (jeColl) {
  const recent = await db
    .collection(jeColl)
    .find({}, { projection: { journalItems: 0 } })
    .sort({ _id: -1 })
    .limit(3)
    .toArray();
  for (const d of recent) {
    console.log(JSON.stringify(d, null, 2));
    console.log('─');
  }
}

// ─── 6. Bonus: scan ALL collections for ANY field === one of the suspect IDs ──
//        (catches cases where the JE was written to an unexpected collection
//         under a non-_id field, or where someone stored the OID as a string.)
console.log();
console.log('─── BROAD SCAN: any field equals any suspect ID (top 200 by ${name})───');
console.log('(Skips collections > 50k docs to keep this fast)');
for (const { name, count } of allCounts) {
  if (typeof count === 'number' && count > 50000) continue;
  if (typeof count !== 'number' || count === 0) continue;
  for (const suspect of SUSPECT_IDS) {
    const oid = asObjectId(suspect.id);
    // Search several common fields the JE id might masquerade as
    const orClauses = [
      { _id: oid },
      { _id: suspect.id },
      { journalEntryId: oid },
      { journalEntryId: suspect.id },
      { 'sourceRef.sourceId': suspect.id },
      { 'metadata.journalEntryId': suspect.id },
      { 'metadata.journalEntryId': oid },
      { reverseOf: oid },
      { reverseOf: suspect.id },
    ].filter((c) => Object.values(c).every((v) => v !== null && v !== undefined));
    try {
      const hit = await db.collection(name).findOne({ $or: orClauses });
      if (hit) {
        console.log(`  HIT in '${name}' for suspect ${suspect.id}:`);
        console.log('   ', JSON.stringify(hit).slice(0, 800));
      }
    } catch {
      // ignore
    }
  }
}

console.log();
console.log('='.repeat(80));
console.log('Probe complete. Disconnecting.');
console.log('='.repeat(80));
await mongoose.disconnect();
