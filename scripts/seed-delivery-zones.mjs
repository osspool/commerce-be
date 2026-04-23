/**
 * Seed default delivery zones on the existing PlatformConfig singleton.
 *
 * Idempotent: only inserts zones when `checkout.deliveryZones` is missing
 * or empty. Existing zones are never overwritten.
 *
 * Defaults seeded:
 *   - Inside Dhaka  → 60 BDT (+15 COD charge), matches district "Dhaka", priority 10
 *   - Outside Dhaka → 120 BDT (+20 COD charge), catch-all fallback, priority 0
 *
 * Run: node scripts/seed-delivery-zones.mjs
 * Requires .env with MONGO_URI.
 */

import 'dotenv/config';
import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('MONGO_URI not set');
  process.exit(1);
}

const DEFAULT_ZONES = [
  {
    name: 'Inside Dhaka',
    charge: 60,
    codCharge: 0,
    freeOverAmount: 0,
    match: { divisions: [], districts: ['Dhaka'], areaIds: [] },
    priority: 10,
    isActive: true,
  },
  {
    name: 'Outside Dhaka',
    charge: 120,
    codCharge: 0,
    freeOverAmount: 0,
    match: { divisions: [], districts: [], areaIds: [] },
    priority: 0,
    isActive: true,
  },
];

async function run() {
  await mongoose.connect(MONGO_URI);
  const coll = mongoose.connection.collection('platformconfigs');

  const doc = await coll.findOne({ isSingleton: true });
  if (!doc) {
    console.error('No PlatformConfig singleton found. Boot be-prod once to create it.');
    process.exit(1);
  }

  const existingZones = doc?.checkout?.deliveryZones ?? [];
  const sets = {
    'checkout.deliveryFeeSource': doc?.checkout?.deliveryFeeSource ?? 'zones',
    'checkout.defaultZoneCharge': doc?.checkout?.defaultZoneCharge ?? 120,
    'checkout.flatCharge': doc?.checkout?.flatCharge ?? 60,
  };

  if (existingZones.length > 0) {
    console.log(`PlatformConfig already has ${existingZones.length} zone(s) — skipping zone seed.`);
    await coll.updateOne({ _id: doc._id }, { $set: sets });
    console.log('Ensured deliveryFeeSource/defaultZoneCharge/flatCharge are present.');
  } else {
    await coll.updateOne(
      { _id: doc._id },
      { $set: { ...sets, 'checkout.deliveryZones': DEFAULT_ZONES } },
    );
    console.log(`Seeded ${DEFAULT_ZONES.length} default delivery zones.`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
