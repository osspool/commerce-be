/**
 * Environment Configuration Validator
 *
 * Validates environment variables at startup to fail fast with clear errors.
 * Prevents runtime errors from missing or invalid configuration.
 */
import type { FastifyInstance } from 'fastify';

interface EnvVarValidationRules {
  required?: boolean;
  type?: 'number' | 'boolean';
  format?: RegExp;
  security?: { minLength: number };
}

interface ValidationRulesConfig {
  required: string[];
  requiredInProduction: string[];
  recommended: string[];
  types: Record<string, 'number' | 'boolean'>;
  formats: Record<string, RegExp>;
  security: Record<string, { minLength: number }>;
}

export interface ValidationOptions {
  strict?: boolean;
  silent?: boolean;
}

export interface ValidationResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
  environment: string;
  isProduction: boolean;
}

/**
 * Validation rules for environment variables
 */
const validationRules: ValidationRulesConfig = {
  // Required in all environments
  required: ['JWT_SECRET', 'MONGO_URI'],

  // Required in production only
  requiredInProduction: ['CORS_ORIGIN', 'JWT_REFRESH_SECRET', 'SESSION_SECRET', 'COOKIE_SECRET'],

  // Optional but recommended
  recommended: ['APP_URL', 'FRONTEND_URL', 'PORT'],

  // Type validations
  types: {
    PORT: 'number',
    RATE_LIMIT_MAX: 'number',
    RATE_LIMIT_WINDOW_MS: 'number',
    TRACK_PRODUCT_VIEWS: 'boolean',
    DISABLE_CRON_JOBS: 'boolean',
  },

  // Format validations
  formats: {
    MONGO_URI: /^mongodb(\+srv)?:\/\/.+/,
    APP_URL: /^https?:\/\/.+/,
    FRONTEND_URL: /^https?:\/\/.+/,
    CORS_ORIGIN: /^https?:\/\/.+(,https?:\/\/.+)*$/, // Comma-separated URLs
  },

  // Security checks
  security: {
    JWT_SECRET: { minLength: 32 },
    JWT_REFRESH_SECRET: { minLength: 32 },
    SESSION_SECRET: { minLength: 32 },
    COOKIE_SECRET: { minLength: 32 },
  },
};

/**
 * Validate a single environment variable
 */
function validateEnvVar(key: string, value: string | undefined, rules: EnvVarValidationRules): string[] {
  const errors: string[] = [];

  // Check if required
  if (rules.required && !value) {
    errors.push(`${key} is required but not defined`);
    return errors; // No point checking further
  }

  // Skip further checks if value is empty and not required
  if (!value) {
    return errors;
  }

  // Type validation
  if (rules.type) {
    switch (rules.type) {
      case 'number':
        if (Number.isNaN(Number(value))) {
          errors.push(`${key} must be a number, got: ${value}`);
        }
        break;
      case 'boolean':
        if (!['0', '1', 'true', 'false'].includes(value.toLowerCase())) {
          errors.push(`${key} must be a boolean (0/1/true/false), got: ${value}`);
        }
        break;
    }
  }

  // Format validation
  if (rules.format && !rules.format.test(value)) {
    errors.push(`${key} has invalid format: ${value}`);
  }

  // Security validation
  if (rules.security) {
    if (rules.security.minLength && value.length < rules.security.minLength) {
      errors.push(`${key} is too short for security (min ${rules.security.minLength} chars, got ${value.length})`);
    }

    // Check for common insecure values
    const insecureValues: string[] = ['secret', 'password', 'test', 'dev', '12345'];
    if (insecureValues.some((bad) => value.toLowerCase().includes(bad))) {
      if (process.env.NODE_ENV === 'production' || process.env.ENV === 'prod') {
        errors.push(`${key} appears to be insecure for production: ${value.substring(0, 10)}...`);
      }
    }
  }

  return errors;
}

/**
 * Validate all environment variables
 */
export function validateEnvironment(options: ValidationOptions = {}): ValidationResult {
  const { strict = false, silent = false } = options;
  const env: string = process.env.NODE_ENV || process.env.ENV || 'dev';
  const isProduction: boolean = env === 'production' || env === 'prod';

  const errors: string[] = [];
  const warnings: string[] = [];

  // Check required variables
  for (const key of validationRules.required) {
    const value: string | undefined = process.env[key];
    const varErrors = validateEnvVar(key, value, {
      required: true,
      type: validationRules.types[key],
      format: validationRules.formats[key],
      security: validationRules.security[key],
    });
    errors.push(...varErrors);
  }

  // Check production-required variables
  if (isProduction) {
    for (const key of validationRules.requiredInProduction) {
      const value: string | undefined = process.env[key];
      const varErrors = validateEnvVar(key, value, {
        required: true,
        security: validationRules.security[key],
      });
      errors.push(...varErrors);
    }
  }

  // Check recommended variables (warnings only)
  for (const key of validationRules.recommended) {
    const value: string | undefined = process.env[key];
    if (!value) {
      warnings.push(`${key} is not set (recommended)`);
    }
  }

  // Check types for all defined variables
  for (const [key, type] of Object.entries(validationRules.types)) {
    const value: string | undefined = process.env[key];
    if (value) {
      const varErrors = validateEnvVar(key, value, { type });
      errors.push(...varErrors);
    }
  }

  // Check formats
  for (const [key, format] of Object.entries(validationRules.formats)) {
    const value: string | undefined = process.env[key];
    if (value) {
      const varErrors = validateEnvVar(key, value, { format });
      errors.push(...varErrors);
    }
  }

  // Log results
  if (!silent) {
    if (errors.length > 0) {
      console.error('\n❌ Environment Validation FAILED:');
      for (const err of errors) console.error(`  - ${err}`);
    }

    if (warnings.length > 0) {
      console.warn('\n⚠️  Environment Warnings:');
      for (const warn of warnings) console.warn(`  - ${warn}`);
    }

    if (errors.length === 0 && warnings.length === 0) {
      console.log('✅ Environment validation passed');
    }
  }

  // Determine if validation passed
  const passed: boolean = errors.length === 0 && (!strict || warnings.length === 0);

  return {
    passed,
    errors,
    warnings,
    environment: env,
    isProduction,
  };
}

/**
 * Validate and throw if validation fails
 *
 * Use this at startup to fail fast with clear error messages
 */
export function validateEnvironmentOrThrow(options: ValidationOptions = {}): ValidationResult {
  const result = validateEnvironment(options);

  if (!result.passed) {
    throw new Error(
      `Environment validation failed:\n${result.errors.join('\n')}\n\n` +
        `Fix these issues before starting the application.`,
    );
  }

  return result;
}

/**
 * Create a Fastify plugin for environment validation
 *
 * @example
 * import { envValidationPlugin } from './config/validator.js';
 *
 * await fastify.register(envValidationPlugin, { strict: true });
 */
export async function envValidationPlugin(fastify: FastifyInstance, options: ValidationOptions = {}): Promise<void> {
  const result = validateEnvironment(options);

  if (!result.passed) {
    throw new Error(`Environment validation failed:\n${result.errors.join('\n')}`);
  }

  // Add /env endpoint (only in development)
  if (!result.isProduction) {
    fastify.get('/env', async () => {
      return {
        environment: result.environment,
        errors: result.errors,
        warnings: result.warnings,
        variables: Object.keys(process.env)
          .filter((key) => !key.includes('SECRET') && !key.includes('PASSWORD'))
          .reduce<Record<string, string | undefined>>((acc, key) => {
            acc[key] = process.env[key];
            return acc;
          }, {}),
      };
    });
  }

  fastify.log.info(
    {
      environment: result.environment,
      warnings: result.warnings.length,
    },
    'Environment validation passed',
  );
}

/**
 * Get environment info for debugging
 */
export function getEnvironmentInfo(): {
  environment: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  variables: Record<string, string | undefined>;
} {
  return {
    environment: process.env.NODE_ENV || process.env.ENV || 'dev',
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    // Filter out sensitive variables
    variables: Object.keys(process.env)
      .filter((key) => !key.includes('SECRET') && !key.includes('PASSWORD'))
      .reduce<Record<string, string | undefined>>((acc, key) => {
        acc[key] = process.env[key];
        return acc;
      }, {}),
  };
}
