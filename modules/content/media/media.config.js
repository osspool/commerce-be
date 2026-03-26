/**
 * Media Module Configuration
 *
 * Configuration for @classytic/media-kit.
 *
 * media-kit SizeVariant: { name, width?, height?, quality?, format?, aspectRatio?, condition? }
 * media-kit AspectRatioPreset: { aspectRatio?, fit?, preserveRatio? }
 *
 * When preserveRatio is true, width/height act as max bounds (scale to fit).
 * fit: 'cover' crops to fill exact dimensions (used only for avatars).
 */

// ============================================
// BASE FOLDERS
// ============================================

export const BASE_FOLDERS = [
  'general',
  'products',
  'categories',
  'blog',
  'users',
  'banners',
  'brands',
];

// ============================================
// SIZE VARIANTS
// ============================================

/**
 * Size variants auto-generated for each uploaded image.
 * width/height are max bounds — aspect ratio is controlled by ASPECT_RATIO_PRESETS.
 */
export const SIZE_VARIANTS = [
  { name: 'thumbnail', width: 200, height: 200, quality: 80, format: 'avif' },
  { name: 'medium', width: 800, height: 800, quality: 80, format: 'avif' },
];

// ============================================
// ASPECT RATIOS
// ============================================

/**
 * Aspect ratio presets by content type.
 *
 * preserveRatio: true — scale to fit within bounds, never crop/distort.
 * aspectRatio + fit: 'cover' — crop to exact ratio (only for avatars).
 *
 * Matched via FOLDER_CONTENT_TYPE_MAP or explicit contentType param.
 */
export const ASPECT_RATIO_PRESETS = {
  default: { preserveRatio: true },
  product: { preserveRatio: true },
  category: { preserveRatio: true },
  banner: { preserveRatio: true },
  brand: { preserveRatio: true },
  avatar: { aspectRatio: 1, fit: 'cover' },
};

/**
 * Folder → Content type mapping for auto-detection.
 */
export const FOLDER_CONTENT_TYPE_MAP = {
  product: ['products', 'product'],
  category: ['categories', 'category'],
  banner: ['banners', 'banner'],
  avatar: ['users', 'avatars'],
  brand: ['brands', 'brand'],
};

// ============================================
// IMAGE PROCESSING
// ============================================

export const IMAGE_SETTINGS = {
  defaultMaxWidth: 3840,
  quality: {
    jpeg: 85,
    webp: 85,
    avif: 80,
    png: 100,
  },
  format: 'avif',

  generateAlt: {
    enabled: true,
    strategy: 'filename',
    fallback: 'Image',
  },

  allowedMimeTypes: [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/svg+xml',
    'image/avif',
  ],

  maxSize: 50 * 1024 * 1024,
};

// ============================================
// EXPORTS
// ============================================

export default {
  BASE_FOLDERS,
  SIZE_VARIANTS,
  ASPECT_RATIO_PRESETS,
  FOLDER_CONTENT_TYPE_MAP,
  IMAGE_SETTINGS,
};
