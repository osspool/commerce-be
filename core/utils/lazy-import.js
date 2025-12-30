/**
 * Small helpers for clean, memoized dynamic imports.
 *
 * Notes:
 * - Prefer passing import-map specifiers (e.g. "#modules/...", "#shared/...") so resolution
 *   doesn't depend on the caller file's location.
 * - Use dynamic imports intentionally (e.g. avoid circular deps, optional modules, cold paths).
 */

/**
 * Create a memoized loader for `import(specifier)`.
 * Subsequent calls reuse the same promise.
 *
 * @param {string} specifier
 * @returns {() => Promise<any>}
 */
export function createModuleLoader(specifier) {
  /** @type {Promise<any> | undefined} */
  let promise;
  return () => (promise ??= import(specifier));
}

/**
 * Create a memoized loader for `import(specifier).default`.
 *
 * @param {string} specifier
 * @returns {() => Promise<any>}
 */
export function createDefaultLoader(specifier) {
  const loadModule = createModuleLoader(specifier);
  return async () => (await loadModule()).default;
}

/**
 * Best-effort import (returns null on failure).
 *
 * @param {string} specifier
 * @returns {Promise<any|null>}
 */
export async function importOptional(specifier) {
  try {
    return await import(specifier);
  } catch {
    return null;
  }
}

/**
 * Best-effort default import (returns null on failure).
 *
 * @param {string} specifier
 * @returns {Promise<any|null>}
 */
export async function importOptionalDefault(specifier) {
  const mod = await importOptional(specifier);
  return mod?.default ?? null;
}

