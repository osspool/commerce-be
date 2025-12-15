/**
 * Logistics Module Tests
 *
 * Test files:
 * - logistics.test.js      : Unit tests for models, static areas, and providers
 * - scripts.test.js        : Idempotency tests for setup scripts
 * - redx-integration.test.js : Integration tests (requires API key)
 *
 * Run all:
 *   npm test -- modules/logistics/tests/
 *
 * Run specific:
 *   npm test -- modules/logistics/tests/logistics.test.js
 *
 * Run with API key for integration tests:
 *   REDX_API_KEY=your-key npm test -- modules/logistics/tests/
 */

export * from './logistics.test.js';
export * from './scripts.test.js';
export * from './redx-integration.test.js';
