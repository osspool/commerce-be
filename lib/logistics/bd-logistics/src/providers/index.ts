/**
 * Provider Registry
 *
 * Maps provider names to their implementation classes.
 */

import type { ProviderConfig, ProviderName } from '../types.js';
import { BaseLogisticsProvider } from './base.provider.js';
import { RedXProvider } from './redx.provider.js';
import { ProviderNotFoundError } from '../errors.js';

type ProviderClass = new (config: ProviderConfig) => BaseLogisticsProvider;

const providerRegistry: Record<ProviderName, ProviderClass> = {
  redx: RedXProvider,
  pathao: RedXProvider, // Placeholder - implement when needed
  steadfast: RedXProvider, // Placeholder - implement when needed
};

/**
 * Get provider class by name
 */
export function getProviderClass(providerName: ProviderName): ProviderClass {
  const Provider = providerRegistry[providerName];
  if (!Provider) {
    throw new ProviderNotFoundError(providerName);
  }
  return Provider;
}

/**
 * Create provider instance from config
 */
export function createProvider(config: ProviderConfig): BaseLogisticsProvider {
  const Provider = getProviderClass(config.provider);
  return new Provider(config);
}

/**
 * Get list of supported providers
 */
export function getSupportedProviders(): ProviderName[] {
  return Object.keys(providerRegistry) as ProviderName[];
}

export {
  BaseLogisticsProvider,
  RedXProvider,
};

export default {
  getProviderClass,
  createProvider,
  getSupportedProviders,
  BaseLogisticsProvider,
  RedXProvider,
};
