/**
 * Media Plugin — registers the v3 media-kit engine as an Arc resource.
 *
 * The engine itself lives in `./media.engine.ts` (lazy singleton). This
 * plugin boots it once per app and registers the routes.
 */

import { defineResource } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import type { RouteDefinition } from '@classytic/arc/types';
import type { Repository } from '@classytic/mongokit';
import fp from 'fastify-plugin';
import permissions from '#config/permissions.js';
import { SIZE_VARIANTS } from './media.config.js';
import MediaController from './media.controller.js';
import { ensureMediaEngine, getMediaEngine } from './media.engine.js';
import { mediaSchemas } from './media.schemas.js';

async function mediaPlugin(fastify: import('fastify').FastifyInstance) {
  const engine = await ensureMediaEngine();
  const Media = engine.models.Media;
  const repo = engine.repositories.media;

  fastify.log.info(
    {
      provider: engine.driver.name,
      variants: SIZE_VARIANTS.map((v) => v.name),
    },
    'Media system ready (v3)',
  );

  const controller = new MediaController(repo);

  const mediaResource = defineResource({
    name: 'media',
    displayName: 'Media',
    tag: 'Media',
    prefix: '/media',

    adapter: createMongooseAdapter(Media, repo as unknown as Repository),
    controller,
    // CRUD route schemas — Arc auto-converts Zod via z.toJSONSchema().
    // Arc's CrudSchemas type is JSON-Schema-shaped, but the runtime
    // converter detects Zod (`_zod` marker) and converts it transparently.
    customSchemas: {
      list: { querystring: mediaSchemas.list.querystring as unknown as Record<string, unknown> },
      update: { body: mediaSchemas.update.body as unknown as Record<string, unknown> },
    },
    permissions: {
      list: permissions.media.list,
      get: permissions.media.get,
      update: permissions.media.update,
      delete: permissions.media.delete,
    },
    routes: [
      {
        method: 'GET',
        path: '/folders',
        handler: controller.getFolders.bind(controller),
        permissions: permissions.media.manage,
        raw: true,
        summary: 'Get allowed base folders',
      },
      {
        method: 'GET',
        path: '/folders/tree',
        handler: controller.getFolderTree.bind(controller),
        permissions: permissions.media.manage,
        raw: true,
        summary: 'Get folder tree',
      },
      {
        method: 'GET',
        path: '/folders/:folder/stats',
        handler: controller.getFolderStats.bind(controller),
        permissions: permissions.media.manage,
        raw: true,
        summary: 'Get folder stats',
        schema: mediaSchemas.folderParam,
      },
      {
        method: 'GET',
        path: '/folders/:folder/breadcrumb',
        handler: controller.getBreadcrumb.bind(controller),
        permissions: permissions.media.manage,
        raw: true,
        summary: 'Get folder breadcrumb',
        schema: mediaSchemas.folderParam,
      },
      {
        method: 'GET',
        path: '/folders/:folder/subfolders',
        handler: controller.getSubfolders.bind(controller),
        permissions: permissions.media.manage,
        raw: true,
        summary: 'Get subfolders',
        schema: mediaSchemas.folderParam,
      },
      {
        method: 'PATCH',
        path: '/folders/:folder',
        handler: controller.renameFolder.bind(controller),
        permissions: permissions.media.manage,
        raw: true,
        summary: 'Rename folder',
        schema: mediaSchemas.renameFolder,
      },
      {
        method: 'DELETE',
        path: '/folders/:folder',
        handler: controller.deleteFolder.bind(controller),
        permissions: permissions.media.manage,
        raw: true,
        summary: 'Delete folder',
        schema: mediaSchemas.folderParam,
      },
      {
        method: 'POST',
        path: '/upload',
        handler: controller.upload.bind(controller),
        permissions: permissions.media.manage,
        raw: true,
        summary: 'Upload single file',
      },
      {
        method: 'POST',
        path: '/upload-multiple',
        handler: controller.uploadMultiple.bind(controller),
        permissions: permissions.media.manage,
        raw: true,
        summary: 'Upload multiple files (max 20)',
      },
      {
        method: 'POST',
        path: '/presigned-upload',
        handler: controller.getPresignedUploadUrl.bind(controller),
        permissions: permissions.media.manage,
        raw: true,
        summary: 'Presigned upload URL',
        schema: mediaSchemas.presignedUpload,
      },
      {
        method: 'POST',
        path: '/presigned-upload/confirm',
        handler: controller.confirmPresignedUpload.bind(controller),
        permissions: permissions.media.manage,
        raw: true,
        summary: 'Confirm presigned upload',
        schema: mediaSchemas.confirmUpload,
      },
      {
        method: 'POST',
        path: '/bulk-delete',
        handler: controller.bulkDeleteMedia.bind(controller),
        permissions: permissions.media.manage,
        raw: true,
        summary: 'Delete multiple files',
        schema: mediaSchemas.bulkDelete,
      },
      {
        method: 'POST',
        path: '/move',
        handler: controller.moveToFolder.bind(controller),
        permissions: permissions.media.manage,
        raw: true,
        summary: 'Move files to folder',
        schema: mediaSchemas.move,
      },
      {
        method: 'POST',
        path: '/:id/tags',
        handler: controller.addTags.bind(controller),
        permissions: permissions.media.manage,
        raw: true,
        summary: 'Add tags',
        schema: mediaSchemas.addTags,
      },
      {
        method: 'DELETE',
        path: '/:id/tags',
        handler: controller.removeTags.bind(controller),
        permissions: permissions.media.manage,
        raw: true,
        summary: 'Remove tags',
        schema: mediaSchemas.removeTags,
      },
    ] as RouteDefinition[],
  });

  await fastify.register(mediaResource.toPlugin());
}

export { getMediaEngine };

export default fp(mediaPlugin, {
  name: 'media',
  dependencies: ['register-core-plugins'],
});
