import {
  generateBaseSlug,
  buildScopeQuery,
  findUniqueSlug,
  validateOptions,
} from './utils.js';

/**
 * Mongoose Slug Plugin
 *
 * Automatically generates unique slugs for documents based on a source field.
 * Handles duplicate slugs by appending incremental numbers (Amazon-style: "name", "name-1", "name-2").
 *
 * ## Features:
 * - ✅ Automatic slug generation from source field (e.g., title)
 * - ✅ Duplicate handling with incremental suffixes
 * - ✅ Scoped uniqueness (e.g., per organizationId)
 * - ✅ Works on both create and update operations
 * - ✅ Preserves manual slug entries
 * - ✅ Customizable slugify options
 * - ✅ Supports findOneAndUpdate operations
 *
 * ## Basic Usage:
 * ```javascript
 * import slugPlugin from 'mongoose-slug-plugin';
 *
 * productSchema.plugin(slugPlugin, {
 *   sourceField: 'title'
 * });
 * ```
 *
 * ## Advanced Usage (Multi-tenant):
 * ```javascript
 * productSchema.plugin(slugPlugin, {
 *   sourceField: 'title',
 *   scopeFields: ['organizationId']  // Unique slug per organization
 * });
 * ```
 *
 * ## Custom Configuration:
 * ```javascript
 * productSchema.plugin(slugPlugin, {
 *   sourceField: 'name',
 *   slugField: 'urlSlug',
 *   scopeFields: ['organizationId', 'category'],
 *   updateOnChange: true,
 *   slugifyOptions: { lower: true, strict: true }
 * });
 * ```
 *
 * @param {Schema} schema - Mongoose schema
 * @param {Object} options - Plugin options
 * @param {string} options.sourceField - Field to generate slug from (e.g., 'title')
 * @param {string} [options.slugField='slug'] - Field to store slug in
 * @param {string[]} [options.scopeFields=[]] - Fields to scope uniqueness check (e.g., ['organizationId'])
 * @param {Object} [options.slugifyOptions] - Custom slugify options
 * @param {boolean} [options.updateOnChange=false] - Regenerate slug when source field changes on updates
 */
export function slugPlugin(schema, options = {}) {
  // Validate options
  validateOptions(schema, options);

  const {
    sourceField,
    slugField = 'slug',
    scopeFields = [],
    slugifyOptions = {},
    updateOnChange = false,
  } = options;

  /**
   * Pre-validate hook for new documents and updates
   * Generates slug before validation runs
   */
  schema.pre('validate', async function() {
    try {
      const isSlugModified = this.isModified(slugField);
      const isSourceModified = this.isModified(sourceField);

      // Scenario 1: New document with manual slug -> validate uniqueness
      if (this.isNew && this[slugField]) {
        const scopeQuery = buildScopeQuery(this, scopeFields);
        const baseSlug = this[slugField];

        // Ensure the manual slug is unique
        const uniqueSlug = await findUniqueSlug(
          this.constructor,
          baseSlug,
          scopeQuery,
          this._id,
          slugField
        );

        this[slugField] = uniqueSlug;
        return;
      }

      // Scenario 2: New document without slug -> auto-generate
      if (this.isNew && !this[slugField]) {
        const sourceValue = this.get(sourceField);

        if (!sourceValue) {
          throw new Error(`Cannot generate slug: ${sourceField} is required`);
        }

        const baseSlug = generateBaseSlug(sourceValue, slugifyOptions);

        if (!baseSlug) {
          throw new Error(`Cannot generate slug from ${sourceField}: "${sourceValue}"`);
        }

        const scopeQuery = buildScopeQuery(this, scopeFields);
        const uniqueSlug = await findUniqueSlug(
          this.constructor,
          baseSlug,
          scopeQuery,
          this._id,
          slugField
        );

        this[slugField] = uniqueSlug;
        return;
      }

      // Scenario 3: Update with manual slug change -> validate uniqueness
      if (!this.isNew && isSlugModified) {
        const scopeQuery = buildScopeQuery(this, scopeFields);
        const baseSlug = this[slugField];

        if (!baseSlug) {
          throw new Error('Slug cannot be empty');
        }

        // Ensure the manual slug is unique
        const uniqueSlug = await findUniqueSlug(
          this.constructor,
          baseSlug,
          scopeQuery,
          this._id,
          slugField
        );

        this[slugField] = uniqueSlug;
        return;
      }

      // Scenario 4: Update with source change and updateOnChange enabled -> regenerate
      if (!this.isNew && isSourceModified && updateOnChange) {
        const sourceValue = this.get(sourceField);

        if (!sourceValue) {
          throw new Error(`Cannot generate slug: ${sourceField} is required`);
        }

        const baseSlug = generateBaseSlug(sourceValue, slugifyOptions);

        if (!baseSlug) {
          throw new Error(`Cannot generate slug from ${sourceField}: "${sourceValue}"`);
        }

        const scopeQuery = buildScopeQuery(this, scopeFields);
        const uniqueSlug = await findUniqueSlug(
          this.constructor,
          baseSlug,
          scopeQuery,
          this._id,
          slugField
        );

        this[slugField] = uniqueSlug;
        return;
      }

      // No slug changes needed
    } catch (error) {
      throw error;
    }
  });

  /**
   * Pre-hook for findOneAndUpdate operations
   * Handles slug generation when using Model.findOneAndUpdate()
   */
  schema.pre('findOneAndUpdate', async function() {
    try {
      const update = this.getUpdate();

      // Check if slug is being manually updated
      const manualSlugUpdate = update.$set?.[slugField] || update[slugField];

      // Check if source field is being updated
      const sourceUpdate = update.$set?.[sourceField] || update[sourceField];

      // Get the document being updated to extract scope fields
      const doc = await this.model.findOne(this.getQuery()).lean();

      if (!doc) {
        return;
      }

      // Scenario 1: Manual slug update -> validate uniqueness
      if (manualSlugUpdate) {
        const scopeQuery = {};
        for (const field of scopeFields) {
          const value = update.$set?.[field] || update[field] || doc[field];
          if (value !== undefined && value !== null) {
            scopeQuery[field] = value;
          }
        }

        const uniqueSlug = await findUniqueSlug(
          this.model,
          manualSlugUpdate,
          scopeQuery,
          doc._id,
          slugField
        );

        if (update.$set) {
          update.$set[slugField] = uniqueSlug;
        } else {
          update[slugField] = uniqueSlug;
        }

        return;
      }

      // Scenario 2: Source field update with updateOnChange -> auto-regenerate
      if (sourceUpdate && updateOnChange) {
        const baseSlug = generateBaseSlug(sourceUpdate, slugifyOptions);

        if (!baseSlug) {
          throw new Error(`Cannot generate slug from ${sourceField}: "${sourceUpdate}"`);
        }

        const scopeQuery = {};
        for (const field of scopeFields) {
          const value = update.$set?.[field] || update[field] || doc[field];
          if (value !== undefined && value !== null) {
            scopeQuery[field] = value;
          }
        }

        const uniqueSlug = await findUniqueSlug(
          this.model,
          baseSlug,
          scopeQuery,
          doc._id,
          slugField
        );

        if (update.$set) {
          update.$set[slugField] = uniqueSlug;
        } else {
          update[slugField] = uniqueSlug;
        }

        return;
      }

      // No slug changes needed
    } catch (error) {
      throw error;
    }
  });
}

export default slugPlugin;
