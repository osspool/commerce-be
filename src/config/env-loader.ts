// Load environment variables before any other imports reach process.env.

import fs from 'node:fs';
import path from 'node:path';
import { arcLog } from '@classytic/arc/logger';
import dotenv from 'dotenv';

const log = arcLog('env-loader');

const env: string = process.env.NODE_ENV || process.env.ENV || 'dev';
log.info('Current environment:', env);

function loadAndFixEnv(filePath: string): void {
  try {
    const result = dotenv.config({ path: filePath, override: false });
    if (result.error) {
      log.error(`Error loading environment file ${filePath}:`, result.error);
    } else {
      log.info(`Loaded environment file: ${filePath}`);
    }
  } catch (error) {
    log.error(`Error loading environment file ${filePath}:`, error);
  }
}

const envFilePath: string = path.resolve(process.cwd(), `.env.${env}`);
if (fs.existsSync(envFilePath)) {
  loadAndFixEnv(envFilePath);
} else {
  const defaultEnvPath: string = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(defaultEnvPath)) {
    loadAndFixEnv(defaultEnvPath);
  } else {
    log.warn('No .env file found. Proceeding without environment file.');
  }
}

log.info('Working directory:', process.cwd());
