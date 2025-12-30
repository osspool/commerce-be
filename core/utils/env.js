const required = {
  MONGO_URI: 'Database connection string is required',
  JWT_SECRET: 'JWT secret is required (min 32 characters)',
};

const defaults = {
  NODE_ENV: 'development',
  PORT: 8080,
  HOST: '0.0.0.0',
  LOG_LEVEL: 'info',
};

export function validateEnv() {
  const errors = [];

  for (const [key, message] of Object.entries(required)) {
    if (!process.env[key]) {
      errors.push(`${key}: ${message}`);
    } else if (key === 'JWT_SECRET' && process.env[key].length < 32) {
      errors.push(`${key}: Must be at least 32 characters`);
    }
  }

  if (errors.length > 0) {
    console.error('Environment validation failed:\n');
    errors.forEach(err => console.error(`  - ${err}`));
    process.exit(1);
  }

  for (const [key, value] of Object.entries(defaults)) {
    if (!process.env[key]) {
      process.env[key] = String(value);
    }
  }

  return {
    NODE_ENV: process.env.NODE_ENV,
    PORT: Number(process.env.PORT),
    HOST: process.env.HOST,
    MONGO_URI: process.env.MONGO_URI,
    JWT_SECRET: process.env.JWT_SECRET,
    LOG_LEVEL: process.env.LOG_LEVEL,
    DISABLE_CRON_JOBS: process.env.DISABLE_CRON_JOBS === 'true',
  };
}

export default validateEnv;
