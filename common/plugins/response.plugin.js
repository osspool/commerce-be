/**
 * Response Plugin
 *
 * Decorates reply with utility methods for sending filtered responses.
 *
 * Use Case: Complex responses where Mongoose projections aren't applicable
 * - Aggregation results
 * - Data from multiple sources
 * - Computed fields
 *
 * For simple DB queries, prefer Mongoose .select() (10x faster)
 */

import fp from 'fastify-plugin';
import { filterResponseData } from '#common/utils/field-selection.js';

async function responsePlugin(fastify, opts) {
  /**
   * Send response with field filtering applied
   *
   * @param {Object|Array} data - Data to send
   * @param {Object} preset - Field preset from fieldPresets
   * @param {Object} options - Additional options
   * @param {boolean} options.wrap - Wrap in { success: true, data } format (default: true)
   * @returns {FastifyReply} Reply instance for chaining
   *
   * @example
   * // Complex aggregation
   * const stats = await calculateDashboardStats();
   * return reply.sendFiltered(stats, fieldPresets.dashboard);
   *
   * @example
   * // Raw response (no wrapping)
   * return reply.sendFiltered(items, fieldPresets.items, { wrap: false });
   */
  fastify.decorateReply('sendFiltered', function (data, preset, options = {}) {
    const { wrap = true } = options;

    // Filter data based on user context
    const filtered = filterResponseData(data, preset, this.request.user);

    // Wrap in standard response format if requested
    const response = wrap ? { success: true, data: filtered } : filtered;

    return this.send(response);
  });

  /**
   * Send success response
   *
   * @param {Object|Array} data - Data to send
   * @param {Object} meta - Optional metadata (pagination, etc.)
   * @returns {FastifyReply}
   *
   * @example
   * return reply.success({ id: '123', name: 'Test' });
   *
   * @example
   * return reply.success(items, { total: 100, page: 1 });
   */
  fastify.decorateReply('success', function (data, meta = null) {
    const response = { success: true, data };
    if (meta) {
      response.meta = meta;
    }
    return this.send(response);
  });

  /**
   * Send error response
   *
   * @param {string} message - Error message
   * @param {number} statusCode - HTTP status code (default: 400)
   * @param {Object} details - Additional error details
   * @returns {FastifyReply}
   *
   * @example
   * return reply.error('Invalid input', 400, { field: 'email' });
   */
  fastify.decorateReply('error', function (message, statusCode = 400, details = null) {
    const response = { success: false, message };
    if (details) {
      response.details = details;
    }
    return this.code(statusCode).send(response);
  });
}

export default fp(responsePlugin, {
  name: 'response-plugin',
  dependencies: [], // No dependencies
});
