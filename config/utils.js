// src/config/utils.js

const log = console;

export const getEnv = (key, defaultValue = null) => {
  const value = process.env[key];

  if (!value && defaultValue === null) {
    console.warn(`Environment variable ${key} is missing`);
  }

  return value || defaultValue;
};

/**
 * Parses a value as a boolean (case-insensitive 'true').
 * @param {string|undefined} value The environment variable value.
 * @returns {boolean|undefined} True if value is 'true', false if 'false', undefined otherwise.
 */
export function parseBoolean(value) {
  if (value === undefined || value === null) return undefined;
  return String(value).toLowerCase() === "true";
}

/**
 * Parses a value as an integer, with a default fallback.
 * @param {string|undefined} value The environment variable value.
 * @param {number} defaultValue The value to return if parsing fails or value is not set.
 * @returns {number} The parsed integer or the default value.
 */
export function parseInt(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  const parsed = global.parseInt(value, 10); // Use global.parseInt to avoid conflicts
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Parses a delimited string into an array of trimmed strings.
 * @param {string|undefined} value The environment variable value.
 * @param {string} delimiter The delimiter character(s).
 * @returns {string[]} An array of strings. Returns empty array if value is null/undefined.
 */
export function parseDelimitedString(value, delimiter = ",") {
  if (!value) return [];
  return value
    .split(delimiter)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Checks if a required environment variable is set. Throws an error instead of exiting.
 * @param {string} envVar The name of the environment variable.
 */
export function requiredEnv(envVar) {
  if (!process.env[envVar]) {
    const errorMsg = `Required environment variable ${envVar} is missing.`;
    console.error(`ERROR: ${errorMsg}`);
    throw new Error(errorMsg);
  }
  return process.env[envVar]; // Return the value for convenience
}

/**
 * Logs a warning if a sensitive (optional but recommended) environment variable is missing.
 * @param {string} envVar The name of the environment variable.
 */
export function warnIfMissing(envVar) {
  if (!process.env[envVar]) {
    log.warn(
      `${envVar} is not set. Functionality related to this variable may not work.`
    );
  }
}
