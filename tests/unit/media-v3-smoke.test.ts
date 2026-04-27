/**
 * Media v3 smoke test.
 *
 * Verifies the @classytic/media-kit v3 engine integration in be-prod:
 *   - engine boots on the shared mongoose connection
 *   - upload produces a ready Media document with storage key + public url
 *   - getById + hardDelete round-trip works
 *   - catalog MediaBridge resolves a mediaId → URL/mimeType on attach
 *
 * Uses the in-memory storage driver (no S3 creds needed).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Minimal 1x1 PNG so sharp can actually decode it during processing
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

let server: MongoMemoryServer;

beforeAll(async () => {
  if (mongoose.connection.readyState === 0) {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
  }
}, 60_000);

afterAll(async () => {
  const { destroyMediaEngine } = await import(
    '../../src/resources/content/media/media.engine.js'
  );
  await destroyMediaEngine();
  if (server) {
    await mongoose.disconnect();
    await server.stop();
  }
});

describe('media-kit v3 integration', () => {
  it('boots the engine and exposes a repository', async () => {
    const { ensureMediaEngine } = await import(
      '../../src/resources/content/media/media.engine.js'
    );
    const engine = await ensureMediaEngine();
    expect(engine.repositories.media).toBeTruthy();
    expect(typeof engine.repositories.media.upload).toBe('function');
    expect(engine.models.Media.modelName).toBe('Media');
  });

  it('uploads a file end-to-end', async () => {
    const { ensureMediaEngine } = await import(
      '../../src/resources/content/media/media.engine.js'
    );
    const engine = await ensureMediaEngine();

    const doc = await engine.repositories.media.upload(
      {
        buffer: PNG_1x1,
        filename: 'smoke.png',
        mimeType: 'image/png',
        folder: 'products',
      },
      { userId: 'u_smoke' },
    );

    expect(doc).toBeTruthy();
    expect((doc as { _id: unknown })._id).toBeDefined();
    expect((doc as { status: string }).status).toBe('ready');
    expect((doc as { folder: string }).folder).toBe('products');
    expect((doc as { url: string }).url).toMatch(/^memory:\/\//);
  });

  it('round-trips getById → hardDelete', async () => {
    const { ensureMediaEngine } = await import(
      '../../src/resources/content/media/media.engine.js'
    );
    const engine = await ensureMediaEngine();

    const created = (await engine.repositories.media.upload({
      buffer: PNG_1x1,
      filename: 'delete-me.png',
      mimeType: 'image/png',
      folder: 'general',
    })) as { _id: string };

    const fetched = await engine.repositories.media.getById(String(created._id));
    expect(fetched).toBeTruthy();

    const deleted = await engine.repositories.media.hardDelete(String(created._id));
    expect(deleted).toBe(true);

    const gone = await engine.repositories.media
      .getById(String(created._id), { throwOnNotFound: false } as never)
      .catch(() => null);
    expect(gone).toBeNull();
  });

  it('catalog media bridge resolves mediaId → URL on attach', async () => {
    const [{ ensureMediaEngine }, { createMediaBridge }] = await Promise.all([
      import('../../src/resources/content/media/media.engine.js'),
      import('../../src/resources/catalog/catalog.engine.js'),
    ]);

    const media = await ensureMediaEngine();
    const bridge = createMediaBridge();
    expect(bridge.onProductMediaAttach).toBeTruthy();

    const uploaded = (await media.repositories.media.upload({
      buffer: PNG_1x1,
      filename: 'bridge.png',
      mimeType: 'image/png',
      folder: 'products',
    })) as { _id: string };

    // Input has a mediaId but stub url/dims — bridge fills them from media-kit doc
    const input = [
      {
        mediaContentType: 'IMAGE' as const,
        mediaId: String(uploaded._id),
        position: 0,
        url: '',
        mimeType: '',
        width: 0,
        height: 0,
      },
    ];

    const resolved = await bridge.onProductMediaAttach!(
      input,
      { organizationId: 'org', currency: 'BDT' } as never,
    );

    expect(resolved).toHaveLength(1);
    const first = resolved[0] as { url: string; mimeType: string };
    expect(first.url).toMatch(/^memory:\/\//);
    expect(first.mimeType).toMatch(/^image\//);
  });
});
