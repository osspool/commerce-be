// src/config/env-loader.ts - Load environment variables before any imports
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

// Determine environment
const env: string = process.env.NODE_ENV || process.env.ENV || 'dev';
console.log('Current environment:', env);

// Function to handle the special case where MONGO_URI might be defined multiple times
function loadAndFixEnv(filePath: string): void {
  try {
    // Load the env file using dotenv with override option
    // override: true ensures existing env vars are overwritten by .env file
    const result = dotenv.config({ path: filePath, override: false });

    if (result.error) {
      console.error(`Error loading environment file ${filePath}:`, result.error);
    } else {
      console.log(`✅ Loaded environment file: ${filePath}`);
    }
  } catch (error) {
    console.error(`Error loading environment file ${filePath}:`, error);
  }
}

// Try to load the environment-specific .env file
const envFilePath: string = path.resolve(process.cwd(), `.env.${env}`);
if (fs.existsSync(envFilePath)) {
  loadAndFixEnv(envFilePath);
} else {
  // Fall back to .env if environment-specific file doesn't exist
  const defaultEnvPath: string = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(defaultEnvPath)) {
    loadAndFixEnv(defaultEnvPath);
  } else {
    console.warn('No .env file found. Proceeding without environment file.');
  }
}

// For debugging purposes
console.log('Working directory:', process.cwd());
