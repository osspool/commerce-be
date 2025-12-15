import fp from 'fastify-plugin';
import createCrudRouter from '#routes/utils/createCrudRouter.js';
import archiveController from './archive.controller.js';
import archiveSchemas, { archiveRunQuery } from './schemas.js';
import permissions from '#config/permissions.js';
import archiveRepository from './archive.repository.js';
import fs from 'node:fs/promises';

async function archivePlugin(fastify, opts) {
  await fastify.register(async (instance) => {
    createCrudRouter(instance, archiveController, {
      tag: 'Archive', schemas: archiveSchemas, auth: permissions.transactions,
      additionalRoutes: [
        { method: 'post', path: '/run', schemas: { body: archiveRunQuery }, summary: 'Run archive for orders or transactions and delete originals', authRoles: permissions.transactions.remove,
          handler: async (request, reply) => {
            const archive = await archiveRepository.runArchive({ ...(request.validated?.body || request.body) }, { context: request.context });
            reply.code(201).send({ success: true, data: archive });
          }
        },
        { method: 'get', path: '/download/:id', schemas: { params: archiveSchemas.get?.params }, summary: 'Download archive file', authRoles: permissions.transactions.get,
          handler: async (request, reply) => {
            const arch = await archiveRepository.getById(request.params.id, {});
            const stat = await fs.stat(arch.filePath).catch(() => null);
            if (!stat) return reply.code(404).send({ success: false, message: 'Archive file not found' });
            reply.download ? reply.download(arch.filePath) : reply.sendFile ? reply.sendFile(arch.filePath) : reply.send({ path: arch.filePath });
          }
        },
        { method: 'delete', path: '/purge/:id', summary: 'Superadmin purge archive and file', authRoles: ['superadmin'],
          handler: async (request, reply) => {
            const roles = Array.isArray(request.user?.roles) ? request.user.roles : (request.user?.roles ? [request.user.roles] : []);
            if (!roles.includes('superadmin')) return reply.code(403).send({ success: false, message: 'Forbidden' });
            const arch = await archiveRepository.getById(request.params.id, {});
            await archiveRepository.delete(request.params.id, {});
            await fs.unlink(arch.filePath).catch(() => null);
            reply.code(200).send({ success: true, message: 'Archive purged' });
          }
        },
      ],
    });
  }, { prefix: '/archives' });
}

export default fp(archivePlugin, { name: 'archive-plugin' });



