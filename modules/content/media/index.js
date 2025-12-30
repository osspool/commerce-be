/**
 * Media Module
 * 
 * Uses @classytic/media-kit for production-grade media management.
 * 
 * @example
 * // Upload (media-kit handles processing, variants, storage, DB)
 * const doc = await fastify.media.upload({
 *   buffer,
 *   filename: 'product.jpg',
 *   mimeType: 'image/jpeg',
 *   folder: 'products',
 * });
 * 
 * // Query
 * const images = await fastify.Media.find({ folder: 'products' });
 * 
 * // Delete (removes file + variants from storage + DB)
 * await fastify.media.delete(id);
 */

import mediaPlugin, { getMedia } from './media.plugin.js';

export default mediaPlugin;
export { getMedia };
export { getMediaModel, requireMediaModel, getVariantUrl, getVariantUrls } from './media.model.js';
export { default as MediaController } from './media.controller.js';
export { default as MediaService } from './media.service.js';
export { BASE_FOLDERS, SIZE_VARIANTS, ASPECT_RATIO_PRESETS } from './media.config.js';
export { mediaSchemas, mediaSchemaOptions, CONTENT_TYPES } from './media.schemas.js';
