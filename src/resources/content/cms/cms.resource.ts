import { defineResource } from '@classytic/arc';
import permissions from '#config/permissions.js';
import { createAdapter } from '#shared/adapter.js';
import cmsController from './cms.controller.js';
import CMS from './cms.model.js';
import cmsRepository from './cms.repository.js';

const cmsResource = defineResource({
  name: 'cms',
  displayName: 'CMS',
  tag: 'CMS',
  prefix: '/cms',

  adapter: createAdapter(CMS, cmsRepository),
  controller: cmsController,

  disableDefaultRoutes: true,
  routes: [
    {
      method: 'GET',
      path: '/:slug',
      handler: 'getBySlug',
      summary: 'Get CMS page by slug',
      permissions: permissions.cms.get,
      raw: true,
    },
    {
      method: 'POST',
      path: '/:slug',
      handler: 'getOrCreateBySlug',
      summary: 'Get or create CMS page by slug',
      permissions: permissions.cms.create,
      raw: true,
    },
    {
      method: 'PATCH',
      path: '/:slug',
      handler: 'updateBySlug',
      summary: 'Update CMS page by slug',
      permissions: permissions.cms.update,
      raw: true,
    },
    {
      method: 'DELETE',
      path: '/:slug',
      handler: 'deleteBySlug',
      summary: 'Delete CMS page by slug',
      permissions: permissions.cms.delete,
      raw: true,
    },
  ],
});

export default cmsResource;
