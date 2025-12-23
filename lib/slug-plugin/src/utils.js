import slugify from 'slugify';

/**
 * Default slugify options for consistent slug generation
 */
export const DEFAULT_SLUGIFY_OPTIONS = {
  lower: true,                  // Convert to lowercase
  strict: true,                 // Strip special characters except replacement
  trim: true,                   // Trim leading/trailing replacement chars
  remove: /[*+~.()'"!:@]/g,    // Remove these characters
};

/**
 * Generate a base slug from source text
 *
 * @param {string} text - Source text to slugify
 * @param {Object} options - Slugify options
 * @returns {string} - Generated slug
 *
 * @example
 * generateBaseSlug('Hello World!', {});
 * // => 'hello-world'
 *
 * @example
 * generateBaseSlug('Product Name 2024', { lower: false });
 * // => 'Product-Name-2024'
 */
export function generateBaseSlug(text, options = {}) {
  if (!text || typeof text !== 'string') {
    return '';
  }

  const slugifyOptions = { ...DEFAULT_SLUGIFY_OPTIONS, ...options };
  return slugify(text, slugifyOptions);
}

/**
 * Build scope query from document based on scope fields
 * Used to ensure slug uniqueness within a specific scope (e.g., per organization)
 *
 * @param {Document} doc - Mongoose document
 * @param {string[]} scopeFields - Array of field names to scope by
 * @returns {Object} - Query object for scope filtering
 *
 * @example
 * buildScopeQuery(productDoc, ['organizationId']);
 * // => { organizationId: '507f1f77bcf86cd799439011' }
 *
 * @example
 * buildScopeQuery(courseDoc, ['organizationId', 'category']);
 * // => { organizationId: '...', category: 'programming' }
 */
export function buildScopeQuery(doc, scopeFields = []) {
  const scopeQuery = {};

  for (const field of scopeFields) {
    const value = doc.get ? doc.get(field) : doc[field];
    if (value !== undefined && value !== null) {
      scopeQuery[field] = value;
    }
  }

  return scopeQuery;
}

/**
 * Find the next available slug by checking for duplicates and appending numbers
 * Implements Amazon-style slug disambiguation: "product", "product-1", "product-2", etc.
 *
 * @param {Model} Model - Mongoose model
 * @param {string} baseSlug - Base slug to check
 * @param {Object} scopeQuery - Query to scope uniqueness check (e.g., { organizationId: '123' })
 * @param {ObjectId} excludeId - Document ID to exclude from check (for updates)
 * @param {string} slugField - Name of the slug field
 * @returns {Promise<string>} - Unique slug
 *
 * @example
 * // If "awesome-product" exists, returns "awesome-product-1"
 * await findUniqueSlug(Product, 'awesome-product', { organizationId: '123' }, null, 'slug');
 *
 * @example
 * // When updating, excludes current document from check
 * await findUniqueSlug(Product, 'new-name', { organizationId: '123' }, docId, 'slug');
 */
export async function findUniqueSlug(Model, baseSlug, scopeQuery = {}, excludeId = null, slugField = 'slug') {
  if (!baseSlug) {
    throw new Error('Base slug cannot be empty');
  }

  // Check if base slug is available
  const query = { ...scopeQuery, [slugField]: baseSlug };
  if (excludeId) {
    query._id = { $ne: excludeId };
  }

  const existingDoc = await Model.findOne(query).select('_id').lean();

  // If base slug is available, use it
  if (!existingDoc) {
    return baseSlug;
  }

  // Find all slugs matching the pattern "baseSlug" or "baseSlug-{number}"
  // Example: for baseSlug="product", matches: "product", "product-1", "product-2", "product-10"
  const escapedSlug = baseSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regexPattern = new RegExp(`^${escapedSlug}(?:-(\\d+))?$`);

  const duplicateQuery = {
    ...scopeQuery,
    [slugField]: regexPattern,
  };

  if (excludeId) {
    duplicateQuery._id = { $ne: excludeId };
  }

  const duplicates = await Model.find(duplicateQuery)
    .select(slugField)
    .lean();

  // Extract numbers from existing slugs
  // "product" => 0, "product-1" => 1, "product-5" => 5
  const numbers = duplicates
    .map(doc => {
      const match = doc[slugField].match(regexPattern);
      return match && match[1] ? parseInt(match[1], 10) : 0;
    })
    .filter(num => !isNaN(num));

  // Find the next available number
  const maxNumber = numbers.length > 0 ? Math.max(...numbers) : 0;
  const nextNumber = maxNumber + 1;

  return `${baseSlug}-${nextNumber}`;
}

/**
 * Validate plugin options
 *
 * @param {Schema} schema - Mongoose schema
 * @param {Object} options - Plugin options
 * @throws {Error} - If options are invalid
 */
export function validateOptions(schema, options) {
  const { sourceField, slugField = 'slug' } = options;

  if (!sourceField) {
    throw new Error('slugPlugin requires a sourceField option (e.g., "title")');
  }

  if (!schema.paths[sourceField]) {
    throw new Error(`sourceField '${sourceField}' does not exist in schema`);
  }

  if (!schema.paths[slugField]) {
    throw new Error(`slugField '${slugField}' does not exist in schema`);
  }
}
