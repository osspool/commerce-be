import 'dotenv/config';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '..', '.env.dev'), override: true });

await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
const db = mongoose.connection.db;

const start = new Date(2026, 4, 1);
const end = new Date(2026, 5, 0, 23, 59, 59, 999);

// Same pipeline the CFS algorithm uses, but without org filter to see if
// any JEs of any org match.
const orgs = await db.collection('journalentries').distinct('organizationId', {
  state: 'posted',
  date: { $gte: start, $lte: end },
});
console.log('Distinct organizationIds in May window:', orgs.map((o) => String(o)));

// Now ALSO probe for JEs whose UTC date is in the May UTC window —
// 2026-05-01T00:00:00Z to 2026-06-01T00:00:00Z.
const startUtc = new Date('2026-05-01T00:00:00.000Z');
const endUtc = new Date('2026-05-31T23:59:59.999Z');
const utcMatches = await db.collection('journalentries').countDocuments({
  state: 'posted',
  date: { $gte: startUtc, $lte: endUtc },
});
console.log('Matches in UTC May window:', utcMatches);

// And the reverse — show me the first 10 JEs sorted by date desc.
const last = await db.collection('journalentries').find({ state: 'posted' })
  .sort({ date: -1 })
  .project({ date: 1, organizationId: 1, label: 1 })
  .limit(10).toArray();
console.log('\nLast 10 posted JEs (by date desc):');
for (const j of last) {
  console.log('  ', j.date.toISOString(), 'org=', String(j.organizationId).slice(0, 8), '...', j.label);
}

// The CFS algorithm aggregates over the full collection — let me also test
// a $match-against-Date that mirrors what cash-flow.ts $match looks like
// when a Date object is passed.
const directMatch = await db.collection('journalentries').aggregate([
  { $match: { state: 'posted', date: { $gte: start, $lte: end } } },
  { $count: 'n' },
]).toArray();
console.log('\nAggregation match for May window:', directMatch);

await mongoose.disconnect();
