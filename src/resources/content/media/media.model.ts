/**
 * Media Model
 *
 * Access to the Media model created by @classytic/media-kit.
 * Schema is auto-generated with support for variants, dimensions, etc.
 *
 * NOTE: Model is only available AFTER media plugin is registered.
 */

import mongoose from 'mongoose';

interface MediaVariant {
  name: string;
  url: string;
  width?: number;
  height?: number;
}

interface MediaDocument {
  url: string;
  variants?: MediaVariant[];
  [key: string]: unknown;
}

/**
 * Get Media model (lazy access)
 */
export function getMediaModel(): mongoose.Model<Record<string, unknown>> | undefined {
  return mongoose.models.Media;
}

/**
 * Get Media model or throw if not initialized
 */
export function requireMediaModel(): mongoose.Model<Record<string, unknown>> {
  const Media = mongoose.models.Media;
  if (!Media) {
    throw new Error('Media model not initialized. Ensure media plugin is registered.');
  }
  return Media;
}

/**
 * Get variant URL by name
 */
export function getVariantUrl(media: MediaDocument | null | undefined, name: string): string | undefined {
  return media?.variants?.find((v) => v.name === name)?.url;
}

/**
 * Get all variant URLs as object
 */
export function getVariantUrls(media: MediaDocument | null | undefined): Record<string, string | undefined> {
  const urls: Record<string, string | undefined> = { original: media?.url };
  for (const variant of media?.variants || []) {
    urls[variant.name] = variant.url;
  }
  return urls;
}

// Default export (undefined until plugin initializes)
export default mongoose.models.Media;
