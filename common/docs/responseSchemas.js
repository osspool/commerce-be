// Helpers to auto-generate standard Fastify response schemas

export function itemWrapper(entitySchema = { type: 'object', additionalProperties: true }) {
  return {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      data: entitySchema || { type: 'object', additionalProperties: true },
    },
    required: ['success', 'data'],
  };
}


// MongoKit pagination wrapper - supports both offset and keyset pagination
// Offset mode: { success, method: 'offset', docs, total, pages, page, limit, hasNext, hasPrev }
// Keyset mode: { success, method: 'keyset', docs, hasMore, next }
export function paginateWrapper(entitySchema = { type: 'object', additionalProperties: true }) {
  return {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      method: { type: 'string', enum: ['offset', 'keyset'] },
      docs: { type: 'array', items: entitySchema || { type: 'object', additionalProperties: true } },
      // Offset pagination fields
      total: { type: 'number' },
      pages: { type: 'number' },
      page: { type: 'number' },
      limit: { type: 'number' },
      hasNext: { type: 'boolean' },
      hasPrev: { type: 'boolean' },
      // Keyset pagination fields
      hasMore: { type: 'boolean' },
      next: { anyOf: [ { type: 'string' }, { type: 'null' } ] },
    },
    required: ['success', 'docs'],
    additionalProperties: true,
  };
}

export function messageWrapper() {
  return {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      message: { type: 'string' },
    },
    required: ['success'],
  };
}

export function filterEntitySchema(entitySchema, { include = undefined, omit = [] } = {}) {
  const base = entitySchema && typeof entitySchema === 'object' ? JSON.parse(JSON.stringify(entitySchema)) : { type: 'object', additionalProperties: true };
  if (!base.properties || base.type !== 'object') return base;
  if (Array.isArray(include) && include.length) {
    const picked = {};
    for (const key of include) {
      if (base.properties[key]) picked[key] = base.properties[key];
    }
    base.properties = picked;
    if (Array.isArray(base.required)) base.required = base.required.filter((k) => include.includes(k));
  }
  if (Array.isArray(omit) && omit.length) {
    for (const key of omit) delete base.properties[key];
    if (Array.isArray(base.required)) base.required = base.required.filter((k) => !omit.includes(k));
  }
  return base;
}

export function buildCrudResponseSchemas(entitySchema, options = {}) {
  const filtered = filterEntitySchema(entitySchema, options.filter);
  return {
    list: { 200: paginateWrapper(filtered) },
    get: { 200: itemWrapper(filtered), 404: messageWrapper() },
    create: { 201: itemWrapper(filtered) },
    update: { 200: itemWrapper(filtered) },
    remove: { 200: messageWrapper() },
  };
}

export default {
  itemWrapper,
  paginateWrapper,
  messageWrapper,
  filterEntitySchema,
  buildCrudResponseSchemas,
};


