import { warnIfMissing } from '../utils.js';

/**
 * Logistics Configuration
 *
 * Provider settings for shipping/delivery integrations.
 * All configuration is loaded from environment variables.
 *
 * Environment Variables:
 * - REDX_API_URL: RedX API base URL (default: sandbox)
 * - REDX_API_KEY: RedX JWT token
 * - LOGISTICS_DEFAULT_PROVIDER: Default provider name (default: 'redx')
 */

// Warn if RedX credentials are missing
warnIfMissing('REDX_API_KEY');

const logisticsConfig = {
  logistics: {
    // Default provider to use
    defaultProvider: process.env.LOGISTICS_DEFAULT_PROVIDER || 'redx',

    // Provider-specific configurations
    providers: {
      redx: {
        apiUrl: process.env.REDX_API_URL || 'https://sandbox.redx.com.bd/v1.0.0-beta',
        apiKey: process.env.REDX_API_KEY || '',
        isSandbox: (process.env.REDX_API_URL || '').includes('sandbox'),
      },

      // Add other providers here as needed
      // pathao: { ... },
      // steadfast: { ... },
    },
  },
};

export default logisticsConfig;
