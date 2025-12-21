import fp from 'fastify-plugin';
import createCrudRouter from '#routes/utils/createCrudRouter.js';
import branchController from './branch.controller.js';
import branchSchemas from './branch.schemas.js';
import permissions from '#config/permissions.js';

async function branchPlugin(fastify) {
  fastify.register((instance, _opts, done) => {
    createCrudRouter(instance, branchController, {
      tag: 'Branches',
      basePath: '/api/v1/branches',
      schemas: branchSchemas,
      auth: permissions.branches,
      additionalRoutes: [
        {
          method: 'GET',
          path: '/code/:code',
          summary: 'Get branch by code',
          handler: branchController.getByCode,
          authRoles: permissions.branches.byCode,
          response: 'get',
          schemas: {
            params: {
              type: 'object',
              properties: {
                code: { type: 'string' },
              },
              required: ['code'],
            },
          },
        },
        {
          method: 'GET',
          path: '/default',
          summary: 'Get default branch (auto-creates if none exists)',
          handler: branchController.getDefault,
          authRoles: permissions.branches.default,
          response: 'get',
        },
        {
          method: 'POST',
          path: '/:id/set-default',
          summary: 'Set branch as default',
          handler: branchController.setDefault,
          authRoles: permissions.branches.setDefault,
          response: 'get',
          schemas: {
            params: {
              type: 'object',
              properties: {
                id: { type: 'string' },
              },
              required: ['id'],
            },
          },
        },
        // Note: For active branches, use GET /branches?isActive=true
      ],
    });

    done();
  }, { prefix: '/branches' });
}

export default fp(branchPlugin, {
  name: 'branch',
  dependencies: ['register-core-plugins'],
});
