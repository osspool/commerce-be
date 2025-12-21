// ============ CORE MODULES ============
import usersRoutes from '#modules/auth/auth.plugin.js';
import exportRoutes from '#modules/export/export.plugin.js';
import jobRoutes from '#modules/job/job.plugin.js';

// ============ BUSINESS & PLATFORM ============
import platformRoutes from '#modules/platform/platform.plugin.js';

// ============ CRM ============
import customerRoutes from '#modules/customer/customer.plugin.js';

// ============ COMMERCE ============
import commerceRoutes from '#modules/commerce/index.js';
import mediaRoutes from '#modules/media/media.plugin.js';
import cmsRoutes from '#modules/cms/cms.plugin.js';

// ============ FINANCIAL ============
import transactionRoutes from '#modules/transaction/routes.js';
import analyticsRoutes from '#modules/analytics/analytics.plugin.js';
import financeRoutes from '#modules/finance/finance.plugin.js';

export default async function fastifyRoutes(fastify, opts) {
  // ============ CORE ============
  await fastify.register(usersRoutes);
  await fastify.register(exportRoutes);
  await fastify.register(jobRoutes);

  // ============ PLATFORM ============
  await fastify.register(platformRoutes);

  // ============ CRM ============
  await fastify.register(customerRoutes);

  // ============ COMMERCE ============
  await fastify.register(commerceRoutes);
  await fastify.register(mediaRoutes);
  await fastify.register(cmsRoutes);

  // ============ FINANCIAL ============
  await fastify.register(transactionRoutes);
  await fastify.register(financeRoutes);

  // ============ ANALYTICS ============
  await fastify.register(analyticsRoutes, { prefix: '/analytics' });
}
