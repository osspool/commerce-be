/**
 * Media Module Configuration
 * 
 * Configuration for @classytic/media-kit.
 * All processing, validation, and storage is handled by media-kit.
 * This file just provides the configuration values.
 */

// ============================================
// BASE FOLDERS
// ============================================

/**
 * Allowed base folders for media organization.
 * FE can use this statically (no API call needed for folder dropdown).
 */
export const BASE_FOLDERS = [
  'general',     // Default/uncategorized
  'products',    // Product images → 3:4 aspect ratio
  'categories',  // Category tiles → 1:1 square
  'blog',        // Blog images → preserve ratio
  'users',       // Avatars → 1:1 square
  'banners',     // Banners → 16:9 wide
  'brands',      // Brand logos → preserve ratio
];

// ============================================
// SIZE VARIANTS
// ============================================

/**
 * Size variants auto-generated for each uploaded image.
 * Media-kit generates these automatically on upload.
 *
 * Main image is always stored at full quality.
 *
 * Response includes:
 * {
 *   url: "main-image.webp",
 *   variants: [
 *     { name: "thumbnail", url: "...", width: 150, height: 200 },
 *     { name: "medium", url: "...", width: 600, height: 800 }
 *   ]
 * }
 */
export const SIZE_VARIANTS = [
  { name: 'thumbnail', width: 150, height: 200, quality: 75, format: 'webp' },
  { name: 'medium', width: 600, height: 800, quality: 80, format: 'webp' },
];

// ============================================
// ASPECT RATIOS
// ============================================

/**
 * Aspect ratio presets by content type.
 * Auto-detected from folder path or can be specified via contentType param.
 */
export const ASPECT_RATIO_PRESETS = {
  product: { aspectRatio: 3/4, fit: 'cover' },   // Vertical for e-commerce
  category: { aspectRatio: 1, fit: 'cover' },    // Square tiles
  banner: { aspectRatio: 16/9, fit: 'cover' },   // Wide banners
  avatar: { aspectRatio: 1, fit: 'cover' },      // Square avatars
  default: { preserveRatio: true },              // Keep original
};

/**
 * Folder → Content type mapping for auto-detection.
 * When uploading to "products/xyz", contentType becomes "product".
 */
export const FOLDER_CONTENT_TYPE_MAP = {
  product: ['products', 'product'],
  category: ['categories', 'category'],
  banner: ['banners', 'banner'],
  avatar: ['users', 'avatars'],
};

// ============================================
// IMAGE PROCESSING
// ============================================

export const IMAGE_SETTINGS = {
  // Processing
  defaultMaxWidth: 2048,
  quality: 80,
  format: 'webp',
  
  // Auto alt-text from filename
  generateAlt: {
    enabled: true,
    strategy: 'filename',
    fallback: 'Image',
  },
  
  // Allowed types
  allowedMimeTypes: [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/svg+xml',
    'image/avif',
  ],
  
  // Max 50MB
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
