/**
 * Migrate cart_checkouts index from `unique: { draftId }` to a partial
 * unique index `{ draftId: 1 }, unique where state='open'`.
 *
 * Root bug: the old unique index prevented a draft from ever having a
 * second checkout — so after cancel, `startCheckout` on retry returned
 * the canceled checkout and the subsequent commit threw
 * `StateTransitionError: canceled -> finalized`.
 *
 * Run ONCE after pulling the cart 2026-04 fix. Idempotent.
 *
 *   node scripts/migrate-cart-checkout-index.mjs
 */

import 'dotenv/config';
import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('MONGO_URI not set');
  process.exit(1);
}

async function run() {
  await mongoose.connect(MONGO_URI);
  const coll = mongoose.connection.collection('cart_checkouts');

  const indexes = await coll.indexes();
  const oldIdx = indexes.find(
    (i) => i.name === 'draftId_1' && i.unique === true && !i.partialFilterExpression,
  );

  if (oldIdx) {
    await coll.dropIndex('draftId_1');
    console.log('Dropped old non-partial unique index draftId_1.');
  } else {
    console.log('No old non-partial draftId_1 index found — nothing to drop.');
  }

  // Let mongoose recreate the new partial-unique + state lookup indexes on boot.
  // Alternatively build them explicitly now so the next be-prod start isn't racy.
  await coll.createIndex(
    { draftId: 1 },
    { unique: true, partialFilterExpression: { state: 'open' }, name: 'draftId_1_open_unique' },
  );
  await coll.createIndex({ draftId: 1, state: 1 }, { name: 'draftId_1_state_1' });
  console.log('Ensured new partial-unique + lookup indexes.');

  const after = await coll.indexes();
  console.log('Current cart_checkouts indexes:');
  for (const i of after) {
    console.log(`  - ${i.name}: ${JSON.stringify(i.key)}${i.unique ? ' [unique]' : ''}${i.partialFilterExpression ? ` partial=${JSON.stringify(i.partialFilterExpression)}` : ''}`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
