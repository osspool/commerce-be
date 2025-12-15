/**
 * Media Plugin
 * 
 * Initializes @classytic/media-kit - handles processing, variants, storage, validation.
 * Routes use createCrudRouter for auto swagger generation.
 */

import fp from 'fastify-plugin';
import mongoose from 'mongoose';
import { createMedia } from '@classytic/media-kit';
import { cachePlugin, createMemoryCache } from '@classytic/mongokit';
import { S3Provider } from '@classytic/media-kit/providers/s3';
import config from '#config/index.js';
import createCrudRouter from '#routes/utils/createCrudRouter.js';
import MediaController from './media.controller.js';
import MediaService from './media.service.js';
import { mediaSchemas } from './media.schemas.js';
import {
  BASE_FOLDERS,
  ASPECT_RATIO_PRESETS,
  FOLDER_CONTENT_TYPE_MAP,
  IMAGE_SETTINGS,
  SIZE_VARIANTS,
} from './media.config.js';

let mediaInstance = null;

async function mediaPlugin(fastify) {
  // 1. Create storage provider
  const provider = new S3Provider({
    bucket: config.storage.s3.bucket,
    region: config.aws.region,
    credentials: {
      accessKeyId: config.aws.accessKeyId,
      secretAccessKey: config.aws.secretAccessKey,
    },
    publicUrl: config.storage.s3.publicUrl,
    acl: undefined, // Disable ACL for public bucket with bucket policies
  });

  // 2. Create media-kit (handles EVERYTHING)
  mediaInstance = createMedia({
    provider,
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
    },
    // Mongokit cache plugin (in-memory by default)
    plugins: [
      cachePlugin({
        adapter: createMemoryCache(),
        ttl: 60,       // list/query cache TTL (seconds)
        byIdTtl: 300,  // single document TTL
        debug: fastify.log?.level === 'debug',
      }),
    ],
    logger: fastify.log,
  });

  // 3. Create model & init
  const Media = mongoose.models.Media || mongoose.model('Media', mediaInstance.schema);
  mediaInstance.init(Media);

  // 4. Decorate fastify
  fastify.decorate('media', mediaInstance);
  fastify.decorate('Media', Media);

  fastify.log.info('Media system ready', { 
    provider: 's3', 
    variants: SIZE_VARIANTS.map(v => v.name) 
  });

  // 5. Register routes under /media (prefixed by /api/v1 upstream)
  const mediaService = new MediaService(mediaInstance);
  const controller = new MediaController(mediaService);
  
  await fastify.register(async (instance) => {
    createCrudRouter(instance, controller, {
      tag: 'Media',
      basePath: '/',
      schemas: mediaSchemas,
      auth: {
        list: ['admin'],
        get: ['admin'],
        update: ['admin'],
        remove: ['admin'],
      },
      additionalRoutes: [
        // Folders
        { 
          method: 'GET', 
          path: '/folders', 
          handler: controller.getFolders, 
          authRoles: ['admin'],
          summary: 'Get allowed base folders',
        },
        { 
          method: 'GET', 
          path: '/folders/tree', 
          handler: controller.getFolderTree, 
          authRoles: ['admin'],
          summary: 'Get folder tree for explorer UI',
        },
        {
          method: 'GET',
          path: '/folders/:folder/stats',
          handler: controller.getFolderStats,
          authRoles: ['admin'],
          summary: 'Get folder statistics',
          schemas: mediaSchemas.folderParam,
        },
        {
          method: 'GET',
          path: '/folders/:folder/breadcrumb',
          handler: controller.getBreadcrumb,
          authRoles: ['admin'],
          summary: 'Get folder breadcrumb',
          schemas: mediaSchemas.folderParam,
        },
        {
          method: 'DELETE',
          path: '/folders/:folder',
          handler: controller.deleteFolder,
          authRoles: ['admin'],
          summary: 'Delete all files in folder',
          schemas: mediaSchemas.folderParam,
        },
        
        // Upload (multipart)
        { 
          method: 'POST', 
          path: '/upload', 
          handler: controller.upload, 
          authRoles: ['admin'],
          summary: 'Upload single file',
          description: 'Multipart: file (required), folder, alt, title, contentType, skipProcessing',
        },
        { 
          method: 'POST', 
          path: '/upload-multiple', 
          handler: controller.uploadMultiple, 
          authRoles: ['admin'],
          summary: 'Upload multiple files (max 20)',
          description: 'Multipart: files[] (required), folder, contentType, skipProcessing',
        },
        
        // Bulk operations
        { 
          method: 'POST', 
          path: '/bulk-delete', 
          handler: controller.bulkDelete, 
          authRoles: ['admin'],
          summary: 'Delete multiple files',
          schemas: mediaSchemas.bulkDelete,
        },
        { 
          method: 'POST', 
          path: '/move', 
          handler: controller.moveToFolder, 
          authRoles: ['admin'],
          summary: 'Move files to folder',
          schemas: mediaSchemas.move,
        },
      ],
    });
  }, { prefix: '/media' });
}

export function getMedia() {
  if (!mediaInstance) throw new Error('Media not initialized');
  return mediaInstance;
}

export default fp(mediaPlugin, {
  name: 'media',
  dependencies: ['register-core-plugins'],
});
