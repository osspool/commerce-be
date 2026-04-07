/**
 * Small helpers for clean, memoized dynamic imports.
 *
 * Notes:
 * - Prefer passing import-map specifiers (e.g. "#resources/...", "#shared/...") so resolution
 *   doesn't depend on the caller file's location.
 * - Use dynamic imports intentionally (e.g. avoid circular deps, optional modules, cold paths).
 */

/**
 * Create a memoized loader for `import(specifier)`.
 * Subsequent calls reuse the same promise.
 */
export function createModuleLoader<T = Record<string, unknown>>(specifier: string): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () => (promise ??= import(specifier) as Promise<T>);
}

/**
 * Create a memoized loader for `import(specifier).default`.
 */
export function createDefaultLoader<T = unknown>(specifier: string): () => Promise<T> {
  const loadModule = createModuleLoader<{ default: T }>(specifier);
  return async () => (await loadModule()).default;
}

/**
 * Best-effort import (returns null on failure).
 */
export async function importOptional<T = Record<string, unknown>>(specifier: string): Promise<T | null> {
  try {
    return (await import(specifier)) as T;
  } catch {
    return null;
  }
}

/**
 * Best-effort default import (returns null on failure).
 */
export async function importOptionalDefault<T = unknown>(specifier: string): Promise<T | null> {
  const mod = await importOptional<{ default: T }>(specifier);
  return mod?.default ?? null;
}
