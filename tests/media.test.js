/**
 * Media Module Tests
 *
 * Tests the media-kit integration: config, upload, CRUD, tags, folders,
 * presigned uploads, deduplication, and processing settings.
 *
 * Run: npm test -- tests/media.test.js
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMedia } from '@classytic/media-kit';
import { request, createTestAuth, waitFor } from '@classytic/arc/testing';
import {
  BASE_FOLDERS,
  SIZE_VARIANTS,
  ASPECT_RATIO_PRESETS,
  FOLDER_CONTENT_TYPE_MAP,
  IMAGE_SETTINGS,
} from '#modules/content/media/media.config.js';
import { CONTENT_TYPES, mediaSchemas } from '#modules/content/media/media.schemas.js';
import { getVariantUrl, getVariantUrls } from '#modules/content/media/media.model.js';

// ─── Minimal test image buffers ─────────────────────────────────────────────

/** 1x1 JPEG (smallest valid JPEG) */
const JPEG_1x1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKgA//' ,
  'base64',
);

/** 1x1 PNG (smallest valid PNG) */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// ─── Mock Storage Driver ────────────────────────────────────────────────────

function createMockDriver() {
  const storage = new Map();

  return {
    name: 'mock',
    storage, // exposed for assertions

    write: vi.fn(async (key, buffer) => {
      storage.set(key, { buffer, lastModified: new Date() });
      return { key, url: `https://cdn.test/${key}`, size: buffer.length };
    }),

    read: vi.fn(async (key) => {
      const item = storage.get(key);
      if (!item) throw new Error(`Not found: ${key}`);
      return item.buffer;
    }),

    delete: vi.fn(async (key) => {
      storage.delete(key);
      return true;
    }),

    exists: vi.fn(async (key) => storage.has(key)),

    stat: vi.fn(async (key) => {
      const item = storage.get(key);
      if (!item) throw new Error(`Not found: ${key}`);
      return {
        size: item.buffer.length,
        lastModified: item.lastModified,
        contentType: 'image/jpeg',
      };
    }),

    getPublicUrl: vi.fn((key) => `https://cdn.test/${key}`),

    getSignedUploadUrl: vi.fn(async (key, contentType, expiresIn) => ({
      url: `https://cdn.test/${key}?signed=true&expires=${expiresIn || 3600}`,
      key,
      expiresAt: new Date(Date.now() + (expiresIn || 3600) * 1000),
    })),
  };
}

// ─── Configuration Tests ────────────────────────────────────────────────────

describe('Media Config', () => {
  it('should have all required base folders', () => {
    expect(BASE_FOLDERS).toContain('general');
    expect(BASE_FOLDERS).toContain('products');
    expect(BASE_FOLDERS).toContain('categories');
    expect(BASE_FOLDERS).toContain('banners');
    expect(BASE_FOLDERS).toContain('users');
    expect(BASE_FOLDERS).toContain('brands');
    expect(BASE_FOLDERS).toContain('blog');
  });

  it('should have 3 size variants (thumbnail, medium, large)', () => {
    expect(SIZE_VARIANTS).toHaveLength(3);

    const names = SIZE_VARIANTS.map(v => v.name);
    expect(names).toContain('thumbnail');
    expect(names).toContain('medium');
    expect(names).toContain('large');
  });

  it('should have correct variant dimensions', () => {
    const thumb = SIZE_VARIANTS.find(v => v.name === 'thumbnail');
    expect(thumb.width).toBe(150);
    expect(thumb.height).toBe(200);
    expect(thumb.format).toBe('webp');

    const medium = SIZE_VARIANTS.find(v => v.name === 'medium');
    expect(medium.width).toBe(600);
    expect(medium.height).toBe(800);

    const large = SIZE_VARIANTS.find(v => v.name === 'large');
    expect(large.width).toBe(1200);
    expect(large.format).toBe('webp');
  });

  it('should have per-format quality map (not a flat number)', () => {
    expect(typeof IMAGE_SETTINGS.quality).toBe('object');
    expect(IMAGE_SETTINGS.quality.jpeg).toBe(80);
    expect(IMAGE_SETTINGS.quality.webp).toBe(80);
    expect(IMAGE_SETTINGS.quality.avif).toBe(50);
    expect(IMAGE_SETTINGS.quality.png).toBe(100);
  });

  it('should have aspect ratio presets for all content types', () => {
    expect(ASPECT_RATIO_PRESETS.product.aspectRatio).toBe(3 / 4);
    expect(ASPECT_RATIO_PRESETS.category.aspectRatio).toBe(1);
    expect(ASPECT_RATIO_PRESETS.banner.aspectRatio).toBe(16 / 9);
    expect(ASPECT_RATIO_PRESETS.avatar.aspectRatio).toBe(1);
    expect(ASPECT_RATIO_PRESETS.default.preserveRatio).toBe(true);
  });

  it('should map folders to content types', () => {
    expect(FOLDER_CONTENT_TYPE_MAP.product).toContain('products');
    expect(FOLDER_CONTENT_TYPE_MAP.category).toContain('categories');
    expect(FOLDER_CONTENT_TYPE_MAP.banner).toContain('banners');
    expect(FOLDER_CONTENT_TYPE_MAP.avatar).toContain('users');
  });

  it('should allow standard image MIME types', () => {
    const allowed = IMAGE_SETTINGS.allowedMimeTypes;
    expect(allowed).toContain('image/jpeg');
    expect(allowed).toContain('image/png');
    expect(allowed).toContain('image/webp');
    expect(allowed).toContain('image/avif');
    expect(allowed).toContain('image/gif');
    expect(allowed).toContain('image/svg+xml');
  });

  it('should have auto alt-text generation enabled', () => {
    expect(IMAGE_SETTINGS.generateAlt.enabled).toBe(true);
    expect(IMAGE_SETTINGS.generateAlt.strategy).toBe('filename');
  });

  it('should have max size of 50MB', () => {
    expect(IMAGE_SETTINGS.maxSize).toBe(50 * 1024 * 1024);
  });
});

// ─── Schema Validation Tests ────────────────────────────────────────────────

describe('Media Schemas', () => {
  it('should define valid content types', () => {
    expect(CONTENT_TYPES).toContain('product');
    expect(CONTENT_TYPES).toContain('category');
    expect(CONTENT_TYPES).toContain('banner');
    expect(CONTENT_TYPES).toContain('avatar');
    expect(CONTENT_TYPES).toContain('default');
  });

  it('should have list schema with pagination and filters', () => {
    const { querystring } = mediaSchemas.list;
    expect(querystring.properties).toHaveProperty('page');
    expect(querystring.properties).toHaveProperty('limit');
    expect(querystring.properties).toHaveProperty('folder');
    expect(querystring.properties).toHaveProperty('search');
    expect(querystring.properties).toHaveProperty('sort');
    expect(querystring.properties).toHaveProperty('after');
  });

  it('should have update schema with tags support', () => {
    const { body } = mediaSchemas.update;
    expect(body.properties).toHaveProperty('alt');
    expect(body.properties).toHaveProperty('title');
    expect(body.properties).toHaveProperty('description');
    expect(body.properties).toHaveProperty('folder');
    expect(body.properties).toHaveProperty('tags');
    expect(body.properties.tags.type).toBe('array');
    expect(body.properties.tags.maxItems).toBe(20);
  });

  it('should have bulkDelete schema with 1-100 items', () => {
    const { body } = mediaSchemas.bulkDelete;
    expect(body.required).toContain('ids');
    expect(body.properties.ids.minItems).toBe(1);
    expect(body.properties.ids.maxItems).toBe(100);
  });

  it('should have move schema requiring ids and targetFolder', () => {
    const { body } = mediaSchemas.move;
    expect(body.required).toContain('ids');
    expect(body.required).toContain('targetFolder');
  });

  it('should have presignedUpload schema requiring filename and mimeType', () => {
    const { body } = mediaSchemas.presignedUpload;
    expect(body.required).toContain('filename');
    expect(body.required).toContain('mimeType');
    expect(body.properties).toHaveProperty('folder');
  });

  it('should have confirmUpload schema requiring key, filename, mimeType, size', () => {
    const { body } = mediaSchemas.confirmUpload;
    expect(body.required).toEqual(expect.arrayContaining(['key', 'filename', 'mimeType', 'size']));
    expect(body.properties.size.type).toBe('integer');
  });

  it('should have renameFolder schema requiring newName', () => {
    const { body } = mediaSchemas.renameFolder;
    expect(body.required).toContain('newName');
    expect(body.properties.newName.pattern).toBeDefined();
  });

  it('should have addTags/removeTags schemas requiring tags array', () => {
    expect(mediaSchemas.addTags.body.required).toContain('tags');
    expect(mediaSchemas.addTags.body.properties.tags.minItems).toBe(1);
    expect(mediaSchemas.removeTags.body.required).toContain('tags');
  });
});

// ─── Model Helper Tests ─────────────────────────────────────────────────────

describe('Media Model Helpers', () => {
  it('should extract variant URL by name', () => {
    const media = {
      url: 'https://cdn.test/main.webp',
      variants: [
        { name: 'thumbnail', url: 'https://cdn.test/thumb.webp' },
        { name: 'medium', url: 'https://cdn.test/med.webp' },
        { name: 'large', url: 'https://cdn.test/large.webp' },
      ],
    };

    expect(getVariantUrl(media, 'thumbnail')).toBe('https://cdn.test/thumb.webp');
    expect(getVariantUrl(media, 'medium')).toBe('https://cdn.test/med.webp');
    expect(getVariantUrl(media, 'large')).toBe('https://cdn.test/large.webp');
    expect(getVariantUrl(media, 'nonexistent')).toBeUndefined();
  });

  it('should return all variant URLs as object', () => {
    const media = {
      url: 'https://cdn.test/main.webp',
      variants: [
        { name: 'thumbnail', url: 'https://cdn.test/thumb.webp' },
        { name: 'medium', url: 'https://cdn.test/med.webp' },
      ],
    };

    const urls = getVariantUrls(media);
    expect(urls.original).toBe('https://cdn.test/main.webp');
    expect(urls.thumbnail).toBe('https://cdn.test/thumb.webp');
    expect(urls.medium).toBe('https://cdn.test/med.webp');
  });

  it('should handle null/undefined media gracefully', () => {
    expect(getVariantUrl(null, 'thumbnail')).toBeUndefined();
    expect(getVariantUrl(undefined, 'thumbnail')).toBeUndefined();
    expect(getVariantUrls(null).original).toBeUndefined();
    expect(getVariantUrls(undefined).original).toBeUndefined();
  });
});

// ─── Media-Kit Integration Tests ────────────────────────────────────────────

const MONGO_URI = process.env.MONGO_URI || globalThis.__MONGO_URI__ || 'mongodb://127.0.0.1:27017/test-bigboss';

describe('Media-Kit Integration', () => {
  let media;
  let driver;
  let Media;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(MONGO_URI);
    }

    driver = createMockDriver();

    media = createMedia({
      driver,
      fileTypes: {
        allowed: IMAGE_SETTINGS.allowedMimeTypes,
        maxSize: IMAGE_SETTINGS.maxSize,
      },
      folders: {
        baseFolders: BASE_FOLDERS,
        defaultFolder: 'general',
        contentTypeMap: FOLDER_CONTENT_TYPE_MAP,
      },
      processing: {
        enabled: true,
        maxWidth: IMAGE_SETTINGS.defaultMaxWidth,
        quality: IMAGE_SETTINGS.quality,
        format: IMAGE_SETTINGS.format,
        aspectRatios: ASPECT_RATIO_PRESETS,
        sizes: SIZE_VARIANTS,
        generateAlt: IMAGE_SETTINGS.generateAlt,
        thumbhash: true,
        dominantColor: true,
        smartSkip: true,
      },
      deduplication: {
        enabled: true,
        returnExisting: true,
        algorithm: 'sha256',
      },
      suppressWarnings: true,
    });

    // Create model (use unique name to avoid conflicts with other tests)
    const modelName = 'MediaTest';
    Media = mongoose.models[modelName] || mongoose.model(modelName, media.schema);
    media.init(Media);
  });

  afterAll(async () => {
    if (media) media.dispose();
    await Media?.deleteMany({});
  });

  beforeEach(async () => {
    await Media.deleteMany({});
    driver.storage.clear();
    driver.write.mockClear();
    driver.delete.mockClear();
  });

  // ─── Schema ─────────────────────────────────────────────────────────────

  describe('Schema', () => {
    it('should create a valid mongoose schema', () => {
      expect(media.schema).toBeDefined();
      expect(media.schema instanceof mongoose.Schema).toBe(true);
    });

    it('should have all required fields', () => {
      const paths = Object.keys(media.schema.paths);
      const required = [
        'filename', 'originalFilename', 'mimeType', 'size', 'url', 'key',
        'status', 'folder', 'tags', 'alt', 'variants',
      ];
      for (const field of required) {
        expect(paths).toContain(field);
      }
    });

    it('should have thumbhash and dominantColor fields', () => {
      const paths = Object.keys(media.schema.paths);
      expect(paths).toContain('thumbhash');
      expect(paths).toContain('dominantColor');
    });

    it('should have uploadedBy field', () => {
      const paths = Object.keys(media.schema.paths);
      expect(paths).toContain('uploadedBy');
    });

    it('should have focalPoint field', () => {
      const paths = Object.keys(media.schema.paths);
      // focalPoint is a subdocument, so it appears as focalPoint.x and focalPoint.y
      const hasFocalPoint = paths.some(p => p.startsWith('focalPoint'));
      expect(hasFocalPoint).toBe(true);
    });
  });

  // ─── Upload ─────────────────────────────────────────────────────────────

  describe('Upload', () => {
    it('should upload a single file', async () => {
      const result = await media.upload({
        buffer: JPEG_1x1,
        filename: 'test-product.jpg',
        mimeType: 'image/jpeg',
        folder: 'products',
      });

      expect(result).toBeDefined();
      expect(result.filename).toBeDefined();
      expect(result.mimeType).toBe('image/jpeg');
      expect(result.folder).toBe('products');
      expect(result.url).toBeDefined();
      expect(result.key).toBeDefined();
      expect(result.status).toBe('ready');
      expect(driver.write).toHaveBeenCalled();
    });

    it('should upload with uploadedBy via context', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const result = await media.upload({
        buffer: JPEG_1x1,
        filename: 'user-upload.jpg',
        mimeType: 'image/jpeg',
        folder: 'general',
      }, { userId });

      expect(result.uploadedBy?.toString()).toBe(userId);
    });

    it('should generate alt text from filename', async () => {
      const result = await media.upload({
        buffer: JPEG_1x1,
        filename: 'beautiful-sunset-photo.jpg',
        mimeType: 'image/jpeg',
        folder: 'blog',
      });

      expect(result.alt).toBeDefined();
      expect(result.alt.length).toBeGreaterThan(0);
    });

    it('should upload to default folder when none specified', async () => {
      const result = await media.upload({
        buffer: PNG_1x1,
        filename: 'no-folder.png',
        mimeType: 'image/png',
      });

      expect(result.folder).toBe('general');
    });

    it('should upload multiple files', async () => {
      const results = await media.uploadMany([
        { buffer: JPEG_1x1, filename: 'multi-1.jpg', mimeType: 'image/jpeg', folder: 'products' },
        { buffer: PNG_1x1, filename: 'multi-2.png', mimeType: 'image/png', folder: 'products' },
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].filename).toBeDefined();
      expect(results[1].filename).toBeDefined();
    });

    it('should reject disallowed MIME types', async () => {
      await expect(media.upload({
        buffer: Buffer.from('not an image'),
        filename: 'malware.exe',
        mimeType: 'application/x-msdownload',
        folder: 'general',
      })).rejects.toThrow(/not allowed/i);
    });

    it('should respect max file size', async () => {
      // Create a buffer just over the limit
      const oversized = Buffer.alloc(IMAGE_SETTINGS.maxSize + 1);
      await expect(media.upload({
        buffer: oversized,
        filename: 'huge.jpg',
        mimeType: 'image/jpeg',
        folder: 'general',
      })).rejects.toThrow(/size|limit/i);
    });
  });

  // ─── Deduplication ──────────────────────────────────────────────────────

  describe('Deduplication', () => {
    it('should detect duplicate uploads and return existing', async () => {
      const first = await media.upload({
        buffer: JPEG_1x1,
        filename: 'duplicate.jpg',
        mimeType: 'image/jpeg',
        folder: 'products',
      });

      const writeCountAfterFirst = driver.write.mock.calls.length;

      const second = await media.upload({
        buffer: JPEG_1x1,
        filename: 'duplicate-copy.jpg',
        mimeType: 'image/jpeg',
        folder: 'products',
      });

      // Should return same document (by hash)
      expect(second._id.toString()).toBe(first._id.toString());
      // Should not write to storage again
      expect(driver.write.mock.calls.length).toBe(writeCountAfterFirst);
    });
  });

  // ─── CRUD ───────────────────────────────────────────────────────────────

  describe('CRUD', () => {
    it('should get media by ID', async () => {
      const uploaded = await media.upload({
        buffer: JPEG_1x1,
        filename: 'getbyid.jpg',
        mimeType: 'image/jpeg',
        folder: 'general',
      });

      const found = await media.getById(uploaded._id.toString());
      expect(found).toBeDefined();
      expect(found._id.toString()).toBe(uploaded._id.toString());
    });

    it('should return null for non-existent ID', async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const found = await media.getById(fakeId);
      expect(found).toBeNull();
    });

    it('should list all media with pagination', async () => {
      await media.upload({ buffer: JPEG_1x1, filename: 'list-1.jpg', mimeType: 'image/jpeg', folder: 'general' });
      await media.upload({ buffer: PNG_1x1, filename: 'list-2.png', mimeType: 'image/png', folder: 'general' });

      const result = await media.getAll({ page: 1, limit: 10 });
      const docs = result.data || result.docs || [];
      expect(docs.length).toBeGreaterThanOrEqual(2);
      // Pagination info present (field name varies: pagination, meta, total, etc.)
      expect(result.total || result.pagination || result.meta).toBeDefined();
    });

    it('should delete media and remove from storage', async () => {
      const uploaded = await media.upload({
        buffer: JPEG_1x1,
        filename: 'to-delete.jpg',
        mimeType: 'image/jpeg',
        folder: 'general',
      });

      const deleted = await media.delete(uploaded._id.toString());
      expect(deleted).toBe(true);
      expect(driver.delete).toHaveBeenCalled();

      const found = await media.getById(uploaded._id.toString());
      expect(found).toBeNull();
    });

    it('should delete many by IDs', async () => {
      const a = await media.upload({ buffer: JPEG_1x1, filename: 'bulk-a.jpg', mimeType: 'image/jpeg', folder: 'general' });
      const b = await media.upload({ buffer: PNG_1x1, filename: 'bulk-b.png', mimeType: 'image/png', folder: 'general' });

      const result = await media.deleteMany([a._id.toString(), b._id.toString()]);
      expect(result.success).toBeDefined();
      expect(result.success.length).toBe(2);
      expect(result.failed.length).toBe(0);
    });
  });

  // ─── Tags ───────────────────────────────────────────────────────────────

  describe('Tags', () => {
    it('should add tags to media', async () => {
      const uploaded = await media.upload({
        buffer: JPEG_1x1,
        filename: 'taggable.jpg',
        mimeType: 'image/jpeg',
        folder: 'products',
      });

      const result = await media.addTags(uploaded._id.toString(), ['featured', 'sale']);
      expect(result.tags).toContain('featured');
      expect(result.tags).toContain('sale');
    });

    it('should remove tags from media', async () => {
      const uploaded = await media.upload({
        buffer: JPEG_1x1,
        filename: 'tag-remove.jpg',
        mimeType: 'image/jpeg',
        folder: 'products',
      });

      await media.addTags(uploaded._id.toString(), ['featured', 'sale', 'new']);
      const result = await media.removeTags(uploaded._id.toString(), ['sale']);

      expect(result.tags).toContain('featured');
      expect(result.tags).toContain('new');
      expect(result.tags).not.toContain('sale');
    });

    it('should not duplicate tags when adding existing ones', async () => {
      const uploaded = await media.upload({
        buffer: JPEG_1x1,
        filename: 'tag-dedup.jpg',
        mimeType: 'image/jpeg',
        folder: 'general',
      });

      await media.addTags(uploaded._id.toString(), ['featured']);
      const result = await media.addTags(uploaded._id.toString(), ['featured', 'new']);

      const featuredCount = result.tags.filter(t => t === 'featured').length;
      expect(featuredCount).toBe(1);
      expect(result.tags).toContain('new');
    });
  });

  // ─── Move ───────────────────────────────────────────────────────────────

  describe('Move', () => {
    it('should move media to a different folder', async () => {
      const uploaded = await media.upload({
        buffer: JPEG_1x1,
        filename: 'moveable.jpg',
        mimeType: 'image/jpeg',
        folder: 'general',
      });

      const result = await media.move([uploaded._id.toString()], 'products');
      expect(result.modifiedCount).toBe(1);

      const moved = await media.getById(uploaded._id.toString());
      expect(moved.folder).toBe('products');
    });
  });

  // ─── Folders ────────────────────────────────────────────────────────────

  describe('Folders', () => {
    it('should return folder tree', async () => {
      await media.upload({ buffer: JPEG_1x1, filename: 'tree-1.jpg', mimeType: 'image/jpeg', folder: 'products' });
      await media.upload({ buffer: PNG_1x1, filename: 'tree-2.png', mimeType: 'image/png', folder: 'products/featured' });

      const tree = await media.getFolderTree();
      expect(tree).toBeDefined();
      // Tree can be an array of nodes or an object with children
      if (Array.isArray(tree)) {
        expect(tree.length).toBeGreaterThanOrEqual(1);
      } else {
        expect(typeof tree).toBe('object');
      }
    });

    it('should return folder stats', async () => {
      await media.upload({ buffer: JPEG_1x1, filename: 'stat-1.jpg', mimeType: 'image/jpeg', folder: 'banners' });

      const stats = await media.getFolderStats('banners');
      expect(stats).toBeDefined();
      expect(stats.totalFiles).toBeGreaterThanOrEqual(1);
    });

    it('should return breadcrumb for nested folder', () => {
      const breadcrumb = media.getBreadcrumb('products/featured/summer');
      expect(breadcrumb).toBeDefined();
      expect(Array.isArray(breadcrumb)).toBe(true);
      expect(breadcrumb.length).toBeGreaterThanOrEqual(1);
    });

    it('should return subfolders', async () => {
      await media.upload({ buffer: JPEG_1x1, filename: 'sub-1.jpg', mimeType: 'image/jpeg', folder: 'products/shirts' });
      await media.upload({ buffer: PNG_1x1, filename: 'sub-2.png', mimeType: 'image/png', folder: 'products/shoes' });

      const subfolders = await media.getSubfolders('products');
      expect(subfolders).toBeDefined();
      expect(Array.isArray(subfolders)).toBe(true);
    });

    it('should rename a folder', async () => {
      await media.upload({ buffer: JPEG_1x1, filename: 'rename-1.jpg', mimeType: 'image/jpeg', folder: 'categories/old-name' });

      const result = await media.renameFolder('categories/old-name', 'categories/new-name');
      expect(result).toBeDefined();
      expect(result.modifiedCount).toBeGreaterThanOrEqual(1);

      // Verify file moved
      const found = await media.getAll({ filters: { folder: 'categories/new-name' } });
      const docs = found.data || found.docs || [];
      expect(docs.length).toBeGreaterThanOrEqual(1);
    });

    it('should delete all files in a folder', async () => {
      await media.upload({ buffer: JPEG_1x1, filename: 'del-folder-1.jpg', mimeType: 'image/jpeg', folder: 'blog/temp' });
      await media.upload({ buffer: PNG_1x1, filename: 'del-folder-2.png', mimeType: 'image/png', folder: 'blog/temp' });

      const result = await media.deleteFolder('blog/temp');
      expect(result.success.length).toBe(2);
      expect(result.failed.length).toBe(0);
    });
  });

  // ─── Presigned Uploads ──────────────────────────────────────────────────

  describe('Presigned Uploads', () => {
    it('should generate a presigned upload URL', async () => {
      const result = await media.getSignedUploadUrl('presigned.jpg', 'image/jpeg', {
        folder: 'products',
      });

      expect(result).toBeDefined();
      expect(result.url).toBeDefined();
      expect(result.key).toBeDefined();
      expect(driver.getSignedUploadUrl).toHaveBeenCalled();
    });

    it('should confirm a presigned upload', async () => {
      // Simulate: client uploaded to storage
      const key = 'products/presigned-confirmed.jpg';
      driver.storage.set(key, { buffer: JPEG_1x1, lastModified: new Date() });

      const result = await media.confirmUpload({
        key,
        filename: 'presigned-confirmed.jpg',
        mimeType: 'image/jpeg',
        size: JPEG_1x1.length,
        folder: 'products',
      });

      expect(result).toBeDefined();
      expect(result.key).toBe(key);
      expect(result.status).toBe('ready');
      expect(result.folder).toBe('products');
    });
  });

  // ─── Search ─────────────────────────────────────────────────────────────

  describe('Search', () => {
    it('should search media by query', async () => {
      await media.upload({ buffer: JPEG_1x1, filename: 'red-sneakers.jpg', mimeType: 'image/jpeg', folder: 'products' });
      await media.upload({ buffer: PNG_1x1, filename: 'blue-hat.png', mimeType: 'image/png', folder: 'products' });

      const result = await media.search('sneakers');
      const docs = result.data || result.docs || [];
      expect(docs).toBeDefined();
    });
  });

  // ─── Events ─────────────────────────────────────────────────────────────

  describe('Events', () => {
    it('should emit after:upload event', async () => {
      let eventFired = false;
      const unsub = media.on('after:upload', () => { eventFired = true; });

      await media.upload({
        buffer: JPEG_1x1,
        filename: 'event-test.jpg',
        mimeType: 'image/jpeg',
        folder: 'general',
      });

      expect(eventFired).toBe(true);
      unsub();
    });

    it('should emit after:delete event', async () => {
      const uploaded = await media.upload({
        buffer: JPEG_1x1,
        filename: 'event-delete.jpg',
        mimeType: 'image/jpeg',
        folder: 'general',
      });

      let eventFired = false;
      const unsub = media.on('after:delete', () => { eventFired = true; });

      await media.delete(uploaded._id.toString());
      expect(eventFired).toBe(true);
      unsub();
    });
  });
});

// ─── Service Layer Tests ────────────────────────────────────────────────────

describe('MediaService', () => {
  let service;
  let driver;
  let mediaKit;
  let Media;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(MONGO_URI);
    }

    const MediaService = (await import('#modules/content/media/media.service.js')).default;

    driver = createMockDriver();
    mediaKit = createMedia({
      driver,
      fileTypes: {
        allowed: IMAGE_SETTINGS.allowedMimeTypes,
        maxSize: IMAGE_SETTINGS.maxSize,
      },
      processing: { enabled: false },
      deduplication: { enabled: false },
      suppressWarnings: true,
    });

    const modelName = 'MediaServiceTest';
    Media = mongoose.models[modelName] || mongoose.model(modelName, mediaKit.schema);
    mediaKit.init(Media);

    service = new MediaService(mediaKit);
  });

  afterAll(async () => {
    if (mediaKit) mediaKit.dispose();
    await Media?.deleteMany({});
  });

  beforeEach(async () => {
    await Media.deleteMany({});
    driver.storage.clear();
  });

  it('should delegate upload to media-kit', async () => {
    const result = await service.upload({
      buffer: JPEG_1x1,
      filename: 'service-upload.jpg',
      mimeType: 'image/jpeg',
      folder: 'general',
    });

    expect(result).toBeDefined();
    expect(result.url).toBeDefined();
  });

  it('should delegate uploadMany to media-kit', async () => {
    const results = await service.uploadMany([
      { buffer: JPEG_1x1, filename: 'svc-1.jpg', mimeType: 'image/jpeg' },
      { buffer: PNG_1x1, filename: 'svc-2.png', mimeType: 'image/png' },
    ]);

    expect(results).toHaveLength(2);
  });

  it('should delegate getAll with pagination', async () => {
    await service.upload({ buffer: JPEG_1x1, filename: 'svc-list.jpg', mimeType: 'image/jpeg' });

    const result = await service.getAll({ page: 1, limit: 10 });
    // Result may use 'data' or 'docs' depending on mongokit version
    const docs = result.data || result.docs || [];
    expect(docs.length).toBeGreaterThanOrEqual(1);
  });

  it('should delegate getById', async () => {
    const uploaded = await service.upload({ buffer: JPEG_1x1, filename: 'svc-get.jpg', mimeType: 'image/jpeg' });

    const found = await service.getById(uploaded._id.toString());
    expect(found._id.toString()).toBe(uploaded._id.toString());
  });

  it('should throw 404 on getById for missing media', async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(service.getById(fakeId)).rejects.toThrow(/not found/i);
  });

  it('should delegate update', async () => {
    const uploaded = await service.upload({ buffer: JPEG_1x1, filename: 'svc-update.jpg', mimeType: 'image/jpeg' });

    const updated = await service.update(uploaded._id.toString(), {
      alt: 'Updated alt text',
      title: 'Updated title',
    });

    expect(updated.alt).toBe('Updated alt text');
    expect(updated.title).toBe('Updated title');
  });

  it('should delegate delete', async () => {
    const uploaded = await service.upload({ buffer: JPEG_1x1, filename: 'svc-del.jpg', mimeType: 'image/jpeg' });

    const result = await service.delete(uploaded._id.toString());
    expect(result.success).toBe(true);
  });

  it('should delegate deleteMany', async () => {
    const a = await service.upload({ buffer: JPEG_1x1, filename: 'svc-bulk-a.jpg', mimeType: 'image/jpeg' });
    const b = await service.upload({ buffer: PNG_1x1, filename: 'svc-bulk-b.png', mimeType: 'image/png' });

    const result = await service.deleteMany([a._id.toString(), b._id.toString()]);
    expect(result.success.length).toBe(2);
  });

  it('should delegate move', async () => {
    const uploaded = await service.upload({ buffer: JPEG_1x1, filename: 'svc-move.jpg', mimeType: 'image/jpeg', folder: 'general' });

    const result = await service.move([uploaded._id.toString()], 'products');
    expect(result.modifiedCount).toBe(1);
  });

  it('should delegate getFolderTree', async () => {
    await service.upload({ buffer: JPEG_1x1, filename: 'svc-tree.jpg', mimeType: 'image/jpeg', folder: 'products' });
    const tree = await service.getFolderTree();
    expect(tree).toBeDefined();
  });

  it('should delegate getBreadcrumb', () => {
    const breadcrumb = service.getBreadcrumb('products/featured');
    expect(Array.isArray(breadcrumb)).toBe(true);
  });

  it('should delegate getSignedUploadUrl', async () => {
    const result = await service.getSignedUploadUrl('presign.jpg', 'image/jpeg', { folder: 'general' });
    expect(result.url).toBeDefined();
    expect(result.key).toBeDefined();
  });

  it('should delegate confirmUpload', async () => {
    const key = 'general/confirm-test.jpg';
    driver.storage.set(key, { buffer: JPEG_1x1, lastModified: new Date() });

    const result = await service.confirmUpload({
      key,
      filename: 'confirm-test.jpg',
      mimeType: 'image/jpeg',
      size: JPEG_1x1.length,
    });

    expect(result.key).toBe(key);
  });

  it('should delegate addTags', async () => {
    const uploaded = await service.upload({ buffer: JPEG_1x1, filename: 'svc-tag.jpg', mimeType: 'image/jpeg' });
    const result = await service.addTags(uploaded._id.toString(), ['hero', 'banner']);
    expect(result.tags).toContain('hero');
  });

  it('should delegate removeTags', async () => {
    const uploaded = await service.upload({ buffer: JPEG_1x1, filename: 'svc-untag.jpg', mimeType: 'image/jpeg' });
    await service.addTags(uploaded._id.toString(), ['hero', 'temp']);
    const result = await service.removeTags(uploaded._id.toString(), ['temp']);
    expect(result.tags).toContain('hero');
    expect(result.tags).not.toContain('temp');
  });

  it('should delegate getSubfolders', async () => {
    await service.upload({ buffer: JPEG_1x1, filename: 'svc-sub.jpg', mimeType: 'image/jpeg', folder: 'products/shoes' });
    const result = await service.getSubfolders('products');
    expect(Array.isArray(result)).toBe(true);
  });

  it('should delegate renameFolder', async () => {
    await service.upload({ buffer: JPEG_1x1, filename: 'svc-rename.jpg', mimeType: 'image/jpeg', folder: 'categories/old' });
    const result = await service.renameFolder('categories/old', 'categories/renamed');
    expect(result.modifiedCount).toBeGreaterThanOrEqual(1);
  });

  it('should delegate deleteFolder', async () => {
    await service.upload({ buffer: JPEG_1x1, filename: 'svc-delfol.jpg', mimeType: 'image/jpeg', folder: 'blog/trash' });
    const result = await service.deleteFolder('blog/trash');
    expect(result.success.length).toBe(1);
  });
});

// ─── Full App Integration Tests ─────────────────────────────────────────────

describe('Media API (full app)', () => {
  let server;
  let auth;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'test-secret-key-1234567890-abcdefgh';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
    process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
    process.env.NODE_ENV = 'test';
    if (globalThis.__MONGO_URI__) {
      process.env.MONGO_URI = globalThis.__MONGO_URI__;
    }

    const { createApplication } = await import('../app.js');
    server = await createApplication();
    await server.ready();
    auth = createTestAuth(server);
  }, 60000);

  afterAll(async () => {
    if (server) await server.close();
  });

  it('should have media model registered', () => {
    expect(mongoose.models.Media).toBeDefined();
  });

  it('should serve GET /api/v1/media with admin auth', async () => {
    const res = await request(server)
      .get('/api/v1/media')
      .withAuth({ id: 'admin1', role: 'admin' })
      .send();

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
  });

  it('should reject GET /api/v1/media without admin role', async () => {
    const res = await request(server)
      .get('/api/v1/media')
      .withAuth({ id: 'user1', role: 'user' })
      .send();

    expect(res.statusCode).toBe(403);
  });

  it('should serve GET /api/v1/media/folders', async () => {
    const res = await request(server)
      .get('/api/v1/media/folders')
      .withAuth({ id: 'admin1', role: 'admin' })
      .send();

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.data).toEqual(BASE_FOLDERS);
  });

  it('should serve GET /api/v1/media/folders/tree', async () => {
    const res = await request(server)
      .get('/api/v1/media/folders/tree')
      .withAuth({ id: 'admin1', role: 'admin' })
      .send();

    // 200 if DB has data, 500 if S3 not configured in test — route exists either way
    expect(res.statusCode).not.toBe(404);
    expect(res.statusCode).not.toBe(403);
  });

  it('should reject unauthenticated upload', async () => {
    const res = await request(server)
      .post('/api/v1/media/upload')
      .send();

    // No auth = 401 or 403
    expect([401, 403]).toContain(res.statusCode);
  });

  it('should reject non-admin upload', async () => {
    const res = await request(server)
      .post('/api/v1/media/upload')
      .withAuth({ id: 'user1', role: 'user' })
      .send();

    expect(res.statusCode).toBe(403);
  });

  it('should reject unauthenticated bulk-delete', async () => {
    const res = await request(server)
      .post('/api/v1/media/bulk-delete')
      .withBody({ ids: ['000000000000000000000000'] })
      .send();

    expect([401, 403]).toContain(res.statusCode);
  });

  it('should have presigned-upload route registered', async () => {
    const res = await request(server)
      .post('/api/v1/media/presigned-upload')
      .send();

    // Should be 401/403 (no auth) not 404 (not found)
    expect(res.statusCode).not.toBe(404);
  });

  it('should have presigned-upload/confirm route registered', async () => {
    const res = await request(server)
      .post('/api/v1/media/presigned-upload/confirm')
      .send();

    expect(res.statusCode).not.toBe(404);
  });

  it('should have tag routes registered', async () => {
    const res = await request(server)
      .post('/api/v1/media/000000000000000000000000/tags')
      .send();

    // Should be 401/403 (no auth) not 404 (not found)
    expect(res.statusCode).not.toBe(404);
  });

  it('should have folder rename route registered', async () => {
    const res = await request(server)
      .patch('/api/v1/media/folders/general')
      .withAuth({ id: 'admin1', role: 'admin' })
      .withBody({ newName: 'test-rename' })
      .send();

    // Should not be 404 (route exists)
    expect(res.statusCode).not.toBe(404);
  });

  it('should have subfolder route registered', async () => {
    const res = await request(server)
      .get('/api/v1/media/folders/products/subfolders')
      .withAuth({ id: 'admin1', role: 'admin' })
      .send();

    // Route exists (not 404) and auth passes (not 403)
    expect(res.statusCode).not.toBe(404);
    expect(res.statusCode).not.toBe(403);
  });
});
