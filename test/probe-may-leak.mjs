import 'dotenv/config';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '..', '.env.dev'), override: true });

await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
const db = mongoose.connection.db;

// What does generateCashFlow's May query actually pass?
// new Date(2026, 4, 1) = local May 1 00:00:00, which on this server = ?
// new Date(2026, 5, 0, 23, 59, 59, 999) = local May 31 23:59:59.999

const start = new Date(2026, 4, 1);
const end = new Date(2026, 5, 0, 23, 59, 59, 999);
console.log('May window start (server local → UTC):', start.toISOString());
console.log('May window end   (server local → UTC):', end.toISOString());
console.log('TZ offset minutes:', new Date().getTimezoneOffset());

const matches = await db.collection('journalentries').find({
  state: 'posted',
  date: { $gte: start, $lte: end },
}).project({ _id: 1, date: 1, label: 1 }).limit(5).toArray();

console.log(`\nMatches in May window: ${matches.length}`);
for (const m of matches) {
  console.log('  ', m.date.toISOString(), m._id.toString().slice(0, 8), m.label);
}

await mongoose.disconnect();
