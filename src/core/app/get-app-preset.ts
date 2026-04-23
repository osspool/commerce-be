import config from '#config/index.js';

type AppPreset = 'production' | 'development' | 'testing';

export function getAppPreset(): AppPreset {
  if (config.isProduction) return 'production';
  if (config.isTest) return 'testing';
  return 'development';
}
