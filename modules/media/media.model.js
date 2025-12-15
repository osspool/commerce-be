/**
 * Media Model
 * 
 * Access to the Media model created by @classytic/media-kit.
 * Schema is auto-generated with support for variants, dimensions, etc.
 * 
 * NOTE: Model is only available AFTER media plugin is registered.
 * Use `fastify.Media` for guaranteed access.
 * 
 * @example
 * // Via Fastify (recommended)
 * const images = await fastify.Media.find({ folder: 'products' });
 * 
 * // Via import (after plugin init)
 * import { requireMediaModel } from '#modules/media/media.model.js';
 * const Media = requireMediaModel();
 * const images = await Media.find({ folder: 'products' });
 * 
 * // Access size variants
 * const media = await Media.findById(id);
 * const thumbnail = media.variants?.find(v => v.name === 'thumbnail')?.url;
 */

import mongoose from 'mongoose';

/**
 * Get Media model (lazy access)
 * @returns {mongoose.Model|undefined}
 */
export function getMediaModel() {
  return mongoose.models.Media;
}

/**
 * Get Media model or throw if not initialized
 * @returns {mongoose.Model}
 */
export function requireMediaModel() {
  const Media = mongoose.models.Media;
  if (!Media) {
    throw new Error('Media model not initialized. Ensure media plugin is registered.');
  }
  return Media;
}

/**
 * Get variant URL by name
 * @param {Object} media - Media document
 * @param {'thumbnail'|'medium'|'large'} name - Variant name
 * @returns {string|undefined}
 */
export function getVariantUrl(media, name) {
  return media?.variants?.find(v => v.name === name)?.url;
}

/**
 * Get all variant URLs as object
 * @param {Object} media - Media document
 * @returns {{original: string, thumbnail?: string, medium?: string, large?: string}}
 */
export function getVariantUrls(media) {
  const urls = { original: media?.url };
  for (const variant of media?.variants || []) {
    urls[variant.name] = variant.url;
  }
  return urls;
}

// Default export (undefined until plugin initializes)
export default mongoose.models.Media;
