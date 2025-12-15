import fp from 'fastify-plugin';
import { createRoutes } from '#routes/utils/createRoutes.js';
import platformConfigController from './platform.controller.js';

async function platformPlugin(fastify) {
  fastify.register((instance, _opts, done) => {
    createRoutes(instance, [
      // ============ Config Routes ============
      {
        method: 'GET',
        url: '/config',
        summary: 'Get platform configuration',
        description: 'Returns full config or selected fields via ?select=field1,field2',
        authRoles: [],
        handler: platformConfigController.getConfig,
      },
      {
        method: 'PATCH',
        url: '/config',
        summary: 'Update platform configuration',
        authRoles: ['admin'],
        handler: platformConfigController.updateConfig,
      },
    ], {
      tag: 'Platform',
      basePath: '/platform',
    });

    done();
  }, { prefix: '/platform' });
}

export default fp(platformPlugin, {
  name: 'platform',
  dependencies: ['register-core-plugins'],
});
