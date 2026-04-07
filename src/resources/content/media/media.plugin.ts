/**
 * Media Plugin — Engine init plugin — resources auto-discovered by loadResources()
 *
 * Initializes @classytic/media-kit - handles processing, variants, storage, validation.
 * Routes use createCrudRouter for Arc OpenAPI generation.
 */

import fp from 'fastify-plugin';
import mongoose from 'mongoose';
import { createMedia } from '@classytic/media-kit';
import type {
  MediaKitConfig,
  SizeVariant,
  AspectRatioPreset,
  AltGenerationConfig,
  FolderConfig,
  ProcessingConfig,
} from '@classytic/media-kit';
import { cachePlugin, createMemoryCache } from '@classytic/mongokit';
import { S3Provider } from '@classytic/media-kit/providers/s3';
import config from '#config/index.js';
import { defineResource } from '@classytic/arc';
import type { AdditionalRoute } from '@classytic/arc';
import { createAdapter } from '#shared/adapter.js';
import permissions from '#config/permissions.js';
import MediaController from './media.controller.js';
import MediaService from './media.service.js';
import { mediaSchemas } from './media.schemas.js';
import { ASPECT_RATIO_PRESETS, FOLDER_CONTENT_TYPE_MAP, IMAGE_SETTINGS, SIZE_VARIANTS } from './media.config.js';

let mediaInstance: ReturnType<typeof createMedia> | null = null;

async function mediaPlugin(fastify: import('fastify').FastifyInstance) {
  // 1. Create storage provider
  const provider = new S3Provider({
    bucket: config.storage.s3.bucket!,
    region: config.aws.region!,
    credentials: {
      accessKeyId: config.aws.accessKeyId!,
      secretAccessKey: config.aws.secretAccessKey!,
    },
    publicUrl: config.storage.s3.publicUrl!,
    acl: undefined, // Disable ACL for public bucket with bucket policies
  });

  // 2. Create media-kit (handles EVERYTHING)
  mediaInstance = createMedia({
    driver: provider,
    fileTypes: {
      allowed: IMAGE_SETTINGS.allowedMimeTypes,
      maxSize: IMAGE_SETTINGS.maxSize,
    },
    folders: {
      defaultFolder: 'general',
      contentTypeMap: FOLDER_CONTENT_TYPE_MAP,
    } satisfies FolderConfig,
    processing: {
      enabled: true,
      maxWidth: IMAGE_SETTINGS.defaultMaxWidth,
      quality: IMAGE_SETTINGS.quality,
      format: IMAGE_SETTINGS.format as ProcessingConfig['format'],
      aspectRatios: ASPECT_RATIO_PRESETS as Record<string, AspectRatioPreset>,
      sizes: SIZE_VARIANTS as SizeVariant[],
      generateAlt: IMAGE_SETTINGS.generateAlt as AltGenerationConfig,
      thumbhash: true,
      dominantColor: true,
      smartSkip: true,
    },
    deduplication: {
      enabled: true,
      returnExisting: true,
      algorithm: 'sha256',
    },
    // Mongokit cache plugin (in-memory by default)
    plugins: [
      cachePlugin({
        adapter: createMemoryCache(),
        ttl: 60, // list/query cache TTL (seconds)
        byIdTtl: 300, // single document TTL
        debug: fastify.log?.level === 'debug',
      }),
    ],
    logger: fastify.log,
  } satisfies MediaKitConfig);

  // 3. Create model & init
  const Media = mongoose.models.Media || mongoose.model('Media', mediaInstance.schema);
  mediaInstance.init(Media);

  // 4. Decorate fastify
  fastify.decorate('media', mediaInstance);
  fastify.decorate('Media', Media);

  fastify.log.info(
    {
      provider: 's3',
      variants: SIZE_VARIANTS.map((v: Record<string, unknown>) => v.name),
    },
    'Media system ready',
  );

  // 5. Register routes under /media (prefixed by /api/v1 upstream)
  // mediaInstance satisfies MediaKit interface expected by MediaService
  const mediaService = new MediaService(mediaInstance as unknown as ConstructorParameters<typeof MediaService>[0]);
  const controller = new MediaController(mediaService);

  const mediaResource = defineResource({
    name: 'media',
    displayName: 'Media',
    tag: 'Media',
    prefix: '/media',

    adapter: createAdapter(Media, mediaService as unknown as import('@classytic/mongokit').Repository),
    controller,
    customSchemas: mediaSchemas,
    permissions: {
      list: permissions.media.list,
      get: permissions.media.get,
      update: permissions.media.update,
      delete: permissions.media.delete,
    },
    additionalRoutes: [
      // Folders
      {
        method: 'GET',
        path: '/folders',
        handler: controller.getFolders.bind(controller),
        permissions: permissions.media.manage,
        wrapHandler: false,
        summary: 'Get allowed base folders',
      },
      {
        method: 'GET',
        path: '/folders/tree',
        handler: controller.getFolderTree.bind(controller),
        permissions: permissions.media.manage,
        wrapHandler: false,
        summary: 'Get folder tree for explorer UI',
      },
      {
        method: 'GET',
        path: '/folders/:folder/stats',
        handler: controller.getFolderStats.bind(controller),
        permissions: permissions.media.manage,
        wrapHandler: false,
        summary: 'Get folder statistics',
        schema: mediaSchemas.folderParam,
      },
      {
        method: 'GET',
        path: '/folders/:folder/breadcrumb',
        handler: controller.getBreadcrumb.bind(controller),
        permissions: permissions.media.manage,
        wrapHandler: false,
        summary: 'Get folder breadcrumb',
        schema: mediaSchemas.folderParam,
      },
      {
        method: 'GET',
        path: '/folders/:folder/subfolders',
        handler: controller.getSubfolders.bind(controller),
        permissions: permissions.media.manage,
        wrapHandler: false,
        summary: 'Get subfolders of a folder',
        schema: mediaSchemas.folderParam,
      },
      {
        method: 'PATCH',
        path: '/folders/:folder',
        handler: controller.renameFolder.bind(controller),
        permissions: permissions.media.manage,
        wrapHandler: false,
        summary: 'Rename a folder',
        schema: mediaSchemas.renameFolder,
      },
      {
        method: 'DELETE',
        path: '/folders/:folder',
        handler: controller.deleteFolder.bind(controller),
        permissions: permissions.media.manage,
        wrapHandler: false,
        summary: 'Delete all files in folder',
        schema: mediaSchemas.folderParam,
      },

      // Upload (multipart)
      {
        method: 'POST',
        path: '/upload',
        handler: controller.upload.bind(controller),
        permissions: permissions.media.manage,
        wrapHandler: false,
        summary: 'Upload single file',
        description: 'Multipart: file (required), folder, alt, title, contentType, skipProcessing',
      },
      {
        method: 'POST',
        path: '/upload-multiple',
        handler: controller.uploadMultiple.bind(controller),
        permissions: permissions.media.manage,
        wrapHandler: false,
        summary: 'Upload multiple files (max 20)',
        description: 'Multipart: files[] (required), folder, contentType, skipProcessing',
      },

      // Presigned uploads (client-side direct-to-S3)
      {
        method: 'POST',
        path: '/presigned-upload',
        handler: controller.getPresignedUploadUrl.bind(controller),
        permissions: permissions.media.manage,
        wrapHandler: false,
        summary: 'Get presigned URL for direct S3 upload',
        schema: mediaSchemas.presignedUpload,
      },
      {
        method: 'POST',
        path: '/presigned-upload/confirm',
        handler: controller.confirmPresignedUpload.bind(controller),
        permissions: permissions.media.manage,
        wrapHandler: false,
        summary: 'Confirm a presigned upload after client finishes',
        schema: mediaSchemas.confirmUpload,
      },

      // Bulk operations
      {
        method: 'POST',
        path: '/bulk-delete',
        handler: controller.bulkDeleteMedia.bind(controller),
        permissions: permissions.media.manage,
        wrapHandler: false,
        summary: 'Delete multiple files',
        schema: mediaSchemas.bulkDelete,
      },
      {
        method: 'POST',
        path: '/move',
        handler: controller.moveToFolder.bind(controller),
        permissions: permissions.media.manage,
        wrapHandler: false,
        summary: 'Move files to folder',
        schema: mediaSchemas.move,
      },

      // Tags
      {
        method: 'POST',
        path: '/:id/tags',
        handler: controller.addTags.bind(controller),
        permissions: permissions.media.manage,
        wrapHandler: false,
        summary: 'Add tags to a media item',
        schema: mediaSchemas.addTags,
      },
      {
        method: 'DELETE',
        path: '/:id/tags',
        handler: controller.removeTags.bind(controller),
        permissions: permissions.media.manage,
        wrapHandler: false,
        summary: 'Remove tags from a media item',
        schema: mediaSchemas.removeTags,
      },
    ] as AdditionalRoute[],
  });

  await fastify.register(mediaResource.toPlugin());
}

export function getMedia() {
  if (!mediaInstance) throw new Error('Media not initialized');
  return mediaInstance;
}

export default fp(mediaPlugin, {
  name: 'media',
  dependencies: ['register-core-plugins'],
});
