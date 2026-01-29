/**
 * Shared Query Parser Instance
 *
 * MongoKit's QueryParser is stateless (all fields are readonly).
 * We create ONE instance and reuse it across all resources for better performance.
 *
 * Benefits:
 * - Memory efficiency: One instance instead of 12+
 * - Consistent behavior: Same parsing config everywhere
 * - Easy to customize: Change config in one place
 *
 * @example
 * import { queryParser } from '#shared/query-parser.js';
 * defineResource({
 *   name: 'product',
 *   queryParser,  // Reuse singleton
 * });
 */

import { QueryParser } from '@classytic/mongokit';

/**
 * Singleton QueryParser instance with production-safe defaults
 *
 * Configuration:
 * - maxLimit: 1000 (prevent resource exhaustion)
 * - maxRegexLength: 500 (ReDoS protection)
 * - maxSearchLength: 200 (prevent abuse)
 * - maxFilterDepth: 10 (prevent filter bombs)
 * - enableLookups: true (allow $lookup joins)
 * - enableAggregations: false (security: requires explicit opt-in)
 */
export const queryParser = new QueryParser({
  maxLimit: 1000,
  maxRegexLength: 500,
  maxSearchLength: 200,
  maxFilterDepth: 10,
  enableLookups: true,
  enableAggregations: false, // Security: disabled by default
});

/**
 * Alternative: QueryParser with aggregations enabled (for admin-only resources)
 *
 * Use this for internal/admin endpoints that need advanced aggregation features.
 *
 * @example
 * import { queryParserWithAggregations } from '#shared/query-parser.js';
 * defineResource({
 *   name: 'analytics',
 *   queryParser: queryParserWithAggregations,
 * });
 */
export const queryParserWithAggregations = new QueryParser({
  maxLimit: 1000,
  maxRegexLength: 500,
  maxSearchLength: 200,
  maxFilterDepth: 10,
  enableLookups: true,
  enableAggregations: true, // Advanced features enabled
});

export default queryParser;
