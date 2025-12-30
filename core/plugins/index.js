/**
 * Core Plugins
 * Framework-level Fastify plugins
 */

export { default as authPlugin } from './auth.plugin.js';
export { default as cachePlugin } from './cache.plugin.js';
export { default as sessionPlugin } from './session.plugin.js';
export { default as schemaGeneratorPlugin } from './schema-generator.plugin.js';
export { default as registerCorePlugins } from './register-core-plugins.js';
