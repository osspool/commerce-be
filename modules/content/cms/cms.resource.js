import { defineResource, createMongooseAdapter } from '@classytic/arc';
import CMS from './cms.model.js';
import cmsRepository from './cms.repository.js';
import cmsController from './cms.controller.js';
import permissions from '#config/permissions.js';

const cmsResource = defineResource({
  name: 'cms',
  displayName: 'CMS',
  tag: 'CMS',
  prefix: '/cms',

  adapter: createMongooseAdapter({
    model: CMS,
    repository: cmsRepository,
  }),
  controller: cmsController,

  disableDefaultRoutes: true,
  additionalRoutes: [
    {
      method: 'GET',
      path: '/:slug',
      handler: 'getBySlug',
      summary: 'Get CMS page by slug',
      permissions: permissions.cms.get,
      wrapHandler: false,
    },
    {
      method: 'POST',
      path: '/:slug',
      handler: 'getOrCreateBySlug',
      summary: 'Get or create CMS page by slug',
      permissions: permissions.cms.create,
      wrapHandler: false,
    },
    {
      method: 'PATCH',
      path: '/:slug',
      handler: 'updateBySlug',
      summary: 'Update CMS page by slug',
      permissions: permissions.cms.update,
      wrapHandler: false,
    },
    {
      method: 'DELETE',
      path: '/:slug',
      handler: 'deleteBySlug',
      summary: 'Delete CMS page by slug',
      permissions: permissions.cms.delete,
      wrapHandler: false,
    },
  ],
});

export default cmsResource;
