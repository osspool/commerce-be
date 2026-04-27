/**
 * Migration: legacy `media` docs → media-kit v3 schema.
 *
 * Legacy shape (pre-media-kit-v3):
 *   { filename, originalName, baseFolder, folder, dimensions: {width, height},
 *     variants: [{ name, url, key, size, width, height }], ... }
 *
 * Media-kit v3 shape (d:/projects/packages/media-kit/src/models/media.schema.ts):
 *   { filename, originalFilename, title, hash, status, folder, width, height,
 *     variants: [{ name, url, key, filename, mimeType, size, width, height }], ... }
 *
 * Transform per doc:
 *   - originalName        → originalFilename       (rename)
 *   - baseFolder          → dropped                (folder already present)
 *   - dimensions.width/h  → width/height (flat)    (dimensions dropped)
 *   - title:   default `''` if missing
 *   - status:  default `'ready'` if missing (objects already exist on S3)
 *   - hash:    `legacy:<_id>` placeholder if missing
 *              (real sha256 is 64 hex chars — placeholder won't collide
 *               and new uploads still dedupe correctly)
 *   - variants[].filename: derive from key basename if missing
 *   - variants[].mimeType: inherit parent mimeType if missing
 *
 * Run:
 *   cd be-prod
 *   node --env-file=.env.dev scripts/migrate-media-v3-schema.mjs --dry
 *   node --env-file=.env.dev scripts/migrate-media-v3-schema.mjs
 */

import mongoose from 'mongoose';
import { basename } from 'node:path';

const DRY_RUN = process.argv.includes('--dry');
const COLLECTION = 'media';

if (!process.env.MONGO_URI) {
  console.error('MONGO_URI missing — run with `node --env-file=.env.dev …`');
  process.exit(1);
}

function buildVariantFix(variant, parentMime) {
  const fix = {};
  if (!variant.filename && variant.key) {
    fix.filename = basename(variant.key);
  }
  if (!variant.mimeType) {
    fix.mimeType = parentMime ?? 'application/octet-stream';
  }
  return fix;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const coll = mongoose.connection.db.collection(COLLECTION);

  const total = await coll.countDocuments({});
  console.log(`[migrate-media] ${COLLECTION}: ${total} docs`);
  console.log(`[migrate-media] mode: ${DRY_RUN ? 'DRY RUN' : 'APPLY'}`);

  const cursor = coll.find({});
  const ops = [];
  let scanned = 0;
  let skipped = 0;

  for await (const doc of cursor) {
    scanned += 1;

    const set = {};
    const unset = {};

    if (doc.originalName && !doc.originalFilename) {
      set.originalFilename = doc.originalName;
      unset.originalName = '';
    }
    if (doc.baseFolder !== undefined) {
      unset.baseFolder = '';
    }
    if (doc.dimensions && typeof doc.dimensions === 'object') {
      if (doc.dimensions.width !== undefined && doc.width === undefined) {
        set.width = doc.dimensions.width;
      }
      if (doc.dimensions.height !== undefined && doc.height === undefined) {
        set.height = doc.dimensions.height;
      }
      unset.dimensions = '';
    }
    if (doc.title === undefined || doc.title === null) {
      set.title = '';
    }
    if (doc.status === undefined || doc.status === null) {
      set.status = 'ready';
    }
    if (!doc.hash) {
      set.hash = `legacy:${doc._id.toString()}`;
    }

    if (Array.isArray(doc.variants) && doc.variants.length > 0) {
      const fixedVariants = doc.variants.map((v) => {
        const patch = buildVariantFix(v, doc.mimeType);
        if (Object.keys(patch).length === 0) return v;
        return { ...v, ...patch };
      });

      // Only write back if at least one variant changed.
      const changed = fixedVariants.some(
        (v, i) => v.filename !== doc.variants[i].filename || v.mimeType !== doc.variants[i].mimeType,
      );
      if (changed) {
        set.variants = fixedVariants;
      }
    }

    if (Object.keys(set).length === 0 && Object.keys(unset).length === 0) {
      skipped += 1;
      continue;
    }

    const update = {};
    if (Object.keys(set).length > 0) update.$set = set;
    if (Object.keys(unset).length > 0) update.$unset = unset;

    ops.push({ updateOne: { filter: { _id: doc._id }, update } });
  }

  console.log(`[migrate-media] scanned=${scanned} needsUpdate=${ops.length} alreadyClean=${skipped}`);

  if (ops.length === 0) {
    console.log('[migrate-media] nothing to do');
    await mongoose.disconnect();
    return;
  }

  if (DRY_RUN) {
    console.log('[migrate-media] sample op:', JSON.stringify(ops[0], null, 2));
    console.log('[migrate-media] DRY RUN — no writes');
    await mongoose.disconnect();
    return;
  }

  const BATCH = 100;
  let written = 0;
  for (let i = 0; i < ops.length; i += BATCH) {
    const chunk = ops.slice(i, i + BATCH);
    const res = await coll.bulkWrite(chunk, { ordered: false });
    written += res.modifiedCount ?? 0;
    process.stdout.write(`\r[migrate-media] written=${written}/${ops.length}`);
  }
  process.stdout.write('\n');
  console.log(`[migrate-media] done — modified=${written}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[migrate-media] failed:', err);
  process.exit(1);
});
