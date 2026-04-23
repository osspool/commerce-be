/**
 * Media Engine — @classytic/media-kit v3 singleton.
 *
 * Lazy-initialized on first access (mirrors catalog.engine.ts pattern).
 * The engine OWNS the Mongoose Media model — callers never build the
 * schema themselves. Domain verbs live on `engine.repositories.media`.
 */

import type {
  AltGenerationConfig,
  AspectRatioPreset,
  MediaConfig,
  MediaEngine,
  SizeVariant,
} from '@classytic/media-kit';
import { createMedia } from '@classytic/media-kit';
import { S3Provider } from '@classytic/media-kit/providers/s3';
import { cachePlugin, createMemoryCache } from '@classytic/mongokit';
import mongoose from 'mongoose';
import config from '#config/index.js';
import { ASPECT_RATIO_PRESETS, FOLDER_CONTENT_TYPE_MAP, IMAGE_SETTINGS, SIZE_VARIANTS } from './media.config.js';

let engine: MediaEngine | null = null;
let pending: Promise<MediaEngine> | null = null;

export function ensureMediaEngine(): Promise<MediaEngine> {
  if (engine) return Promise.resolve(engine);
  if (pending) return pending;

  pending = (async () => {
    const driver = config.storage.s3.bucket
      ? new S3Provider({
          bucket: config.storage.s3.bucket,
          region: config.aws.region!,
          credentials: {
            accessKeyId: config.aws.accessKeyId!,
            secretAccessKey: config.aws.secretAccessKey!,
          },
          publicUrl: config.storage.s3.publicUrl,
          acl: undefined,
        })
      : // Fallback for tests: an in-memory driver
        await (await import('./memory-driver.js')).createMemoryDriver();

    const cfg: MediaConfig = {
      connection: mongoose.connection,
      driver,
      tenant: { tenantFieldType: 'string' },
      fileTypes: {
        allowed: IMAGE_SETTINGS.allowedMimeTypes,
        maxSize: IMAGE_SETTINGS.maxSize,
      },
      folders: {
        defaultFolder: 'general',
        contentTypeMap: FOLDER_CONTENT_TYPE_MAP,
      },
      processing: {
        enabled: true,
        maxWidth: IMAGE_SETTINGS.defaultMaxWidth,
        quality: IMAGE_SETTINGS.quality,
        format: IMAGE_SETTINGS.format as 'avif' | 'webp' | 'jpeg' | 'png',
        aspectRatios: ASPECT_RATIO_PRESETS as Record<string, AspectRatioPreset>,
        sizes: SIZE_VARIANTS as readonly SizeVariant[] as SizeVariant[],
        generateAlt: IMAGE_SETTINGS.generateAlt as AltGenerationConfig,
        thumbhash: true,
        dominantColor: true,
        smartSkip: true,
      },
      deduplication: { enabled: true, returnExisting: true, algorithm: 'sha256' },
      plugins: [
        cachePlugin({
          adapter: createMemoryCache(),
          ttl: 60,
          byIdTtl: 300,
        }),
      ],
    };

    engine = await createMedia(cfg);
    return engine;
  })();

  return pending;
}

export function getMediaEngine(): MediaEngine {
  if (!engine) throw new Error('Media engine not initialized — call ensureMediaEngine() first');
  return engine;
}

export async function destroyMediaEngine(): Promise<void> {
  if (engine) {
    await engine.dispose();
    engine = null;
    pending = null;
  }
}
