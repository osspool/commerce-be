/**
 * Media Request Schemas (Zod v4 — Arc convention).
 *
 * Arc auto-converts these to JSON Schema via `z.toJSONSchema()` for
 * Fastify validation + OpenAPI generation. Reusable upload/confirm
 * shapes are imported from the package so be-prod stays in lockstep
 * with media-kit's domain types.
 *
 * Only request-side schemas live here; response shapes are auto-derived
 * from the Mongoose model by `buildCrudSchemasFromModel` in createMongooseAdapter().
 */

import { createMongooseAdapter } from '@classytic/arc';
import { confirmUploadSchema as kitConfirmUploadSchema } from '@classytic/media-kit/schemas';
import { z } from 'zod';
import { BASE_FOLDERS } from './media.config.js';

/** Content types accepted by the upload pipeline (image processing presets). */
export const CONTENT_TYPES = ['product', 'category', 'banner', 'avatar', 'default'] as const;

/** BaseController field rules — protects system-managed columns from PATCH writes. */
export const mediaSchemaOptions = {
  fieldRules: {
    url: { systemManaged: true },
    key: { systemManaged: true },
    size: { systemManaged: true },
    mimeType: { systemManaged: true },
    dimensions: { systemManaged: true },
    variants: { systemManaged: true },
    uploadedBy: { systemManaged: true },
  },
};

/** Folder path: must start with an allowed base folder, then `/segment` parts. */
const folderPathPattern = new RegExp(`^(${BASE_FOLDERS.join('|')})(/[a-zA-Z0-9_-]+)*$`);
const folderPath = z.string().regex(folderPathPattern, 'Invalid folder path');

const folderParam = z.object({ folder: z.string().min(1) });
const idParam = z.object({ id: z.string().min(1) });
const tagList = z.array(z.string().min(1).max(50)).min(1).max(20);

// ─── Schemas ─────────────────────────────────────────────────

export const mediaSchemas = {
  // GET /api/media — list query
  list: {
    querystring: z.object({
      page: z.coerce.number().int().min(1).optional(),
      after: z.string().optional().describe('Cursor for keyset pagination'),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      folder: folderPath.optional(),
      baseFolder: z.enum(BASE_FOLDERS as [string, ...string[]]).optional(),
      mimeType: z.string().optional(),
      contentType: z.enum(CONTENT_TYPES).optional(),
      search: z.string().optional(),
      sort: z.string().optional(),
    }),
  },

  // PATCH /api/media/:id
  update: {
    body: z
      .object({
        alt: z.string().max(255).optional(),
        title: z.string().max(255).optional(),
        description: z.string().max(1000).optional(),
        folder: folderPath.optional(),
        tags: z.array(z.string().max(50)).max(20).optional(),
      })
      .strict(),
  },

  // GET /folders/:folder/* — bare folder param
  folderParam: { params: folderParam },

  // POST /bulk-delete
  bulkDelete: {
    body: z
      .object({
        ids: z.array(z.string().min(1)).min(1).max(100).describe('Media IDs to delete'),
      })
      .strict(),
  },

  // POST /move
  move: {
    body: z
      .object({
        ids: z.array(z.string().min(1)).min(1).max(100),
        targetFolder: folderPath.describe('Target folder path (e.g. products/featured)'),
      })
      .strict(),
  },

  // POST /presigned-upload
  presignedUpload: {
    body: z
      .object({
        filename: z.string().min(1),
        mimeType: z.string().min(1),
        folder: folderPath.optional(),
      })
      .strict(),
  },

  // POST /presigned-upload/confirm — reuses the package's domain schema
  // and only relaxes the `folder` field to the host's allowed pattern.
  confirmUpload: {
    body: kitConfirmUploadSchema.extend({ folder: folderPath.optional() }),
  },

  // PATCH /folders/:folder
  renameFolder: {
    params: folderParam,
    body: z
      .object({
        newName: z
          .string()
          .min(1)
          .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid folder name'),
      })
      .strict(),
  },

  // POST /:id/tags
  addTags: {
    params: idParam,
    body: z.object({ tags: tagList }).strict(),
  },

  // DELETE /:id/tags
  removeTags: {
    params: idParam,
    body: z.object({ tags: tagList }).strict(),
  },
};
