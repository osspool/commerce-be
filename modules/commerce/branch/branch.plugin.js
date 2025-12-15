import fp from 'fastify-plugin';
import createCrudRouter from '#routes/utils/createCrudRouter.js';
import branchController from './branch.controller.js';
import branchSchemas from './branch.schemas.js';

async function branchPlugin(fastify) {
  fastify.register((instance, _opts, done) => {
    createCrudRouter(instance, branchController, {
      tag: 'Branches',
      basePath: '/api/v1/branches',
      schemas: branchSchemas,
      auth: {
        list: ['admin', 'store-manager'],
        get: ['admin', 'store-manager'],
        create: ['admin'],
        update: ['admin'],
        remove: ['admin'],
      },
      additionalRoutes: [
        {
          method: 'GET',
          path: '/code/:code',
          summary: 'Get branch by code',
          handler: branchController.getByCode,
          authRoles: ['admin', 'store-manager'],
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
          authRoles: ['admin', 'store-manager'],
          response: 'get',
        },
        {
          method: 'POST',
          path: '/:id/set-default',
          summary: 'Set branch as default',
          handler: branchController.setDefault,
          authRoles: ['admin'],
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
        {
          method: 'GET',
          path: '/active',
          summary: 'Get all active branches (simple list)',
          handler: branchController.getActive,
          authRoles: ['admin', 'store-manager'],
          isList: true,
        },
      ],
    });

    done();
  }, { prefix: '/branches' });
}

export default fp(branchPlugin, {
  name: 'branch',
  dependencies: ['register-core-plugins'],
});
