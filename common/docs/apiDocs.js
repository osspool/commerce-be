// common/docs/apiDocs.js
// Lightweight in-memory registry for API docs collected at route creation time

const registry = {
  paths: {},
  components: { schemas: {} },
  tags: new Set(),
};

export function registerPath(path, method, operation) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const lowerMethod = String(method).toLowerCase();
  if (!registry.paths[normalizedPath]) registry.paths[normalizedPath] = {};
  registry.paths[normalizedPath][lowerMethod] = operation;
}

export function registerSchema(name, schema) {
  registry.components.schemas[name] = schema;
}

export function registerTag(tag) {
  if (tag) registry.tags.add(tag);
}

export function getApiSpec() {
  return {
    paths: registry.paths,
    components: registry.components,
    tags: Array.from(registry.tags).map((name) => ({ name })),
  };
}

export function resetApiSpec() {
  registry.paths = {};
  registry.components = { schemas: {} };
  registry.tags = new Set();
}


