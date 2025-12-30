/**
 * Category Module
 *
 * Exports category model, repository, controller, and plugin.
 * Products reference categories by slug (string) for fast queries.
 */

export { default as Category } from './category.model.js';
export { default as categoryRepository } from './category.repository.js';
export { default as categoryController } from './category.controller.js';
export { default as categoryPlugin } from './routes.js';
