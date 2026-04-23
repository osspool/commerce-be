import { warnIfMissing } from '../utils.js';

/**
 * Logistics Configuration
 *
 * Carrier provider settings for shipping/delivery integrations. Reads
 * from environment variables — restart the server after `.env` changes.
 *
 * Environment Variables (all optional — only configured carriers init):
 *   RedX:
 *     REDX_API_URL                  Base URL (defaults to sandbox)
 *     REDX_API_KEY                  Bearer JWT
 *     REDX_DEFAULT_PICKUP_STORE_ID  Numeric pickup store id
 *
 *   Pathao (Aladdin merchant API):
 *     PATHAO_API_URL                Base URL (defaults to sandbox)
 *     PATHAO_CLIENT_ID              OAuth client id
 *     PATHAO_CLIENT_SECRET          OAuth client secret
 *     PATHAO_USERNAME               Merchant login email
 *     PATHAO_PASSWORD               Merchant login password
 *     PATHAO_DEFAULT_STORE_ID       Default pickup store id
 *
 *   Steadfast:
 *     STEADFAST_API_URL             Base URL
 *     STEADFAST_API_KEY             Api-Key header value
 *     STEADFAST_API_SECRET          Secret-Key header value
 *
 *   Selection:
 *     LOGISTICS_DEFAULT_PROVIDER    'redx' | 'pathao' | 'steadfast'
 */

export interface RedxProviderConfig {
  apiUrl?: string;
  apiKey: string;
  isSandbox: boolean;
  defaultPickupStoreId?: number;
}

export interface PathaoProviderConfig {
  apiUrl?: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  defaultStoreCode?: number;
  isSandbox: boolean;
}

export interface SteadfastProviderConfig {
  apiUrl?: string;
  apiKey: string;
  apiSecret: string;
}

export interface LogisticsConfigSection {
  logistics: {
    defaultProvider: 'redx' | 'pathao' | 'steadfast';
    providers: {
      redx?: RedxProviderConfig;
      pathao?: PathaoProviderConfig;
      steadfast?: SteadfastProviderConfig;
    };
  };
}

warnIfMissing('REDX_API_KEY');

const redxKey = process.env.REDX_API_KEY;
const pathaoCreds =
  process.env.PATHAO_CLIENT_ID &&
  process.env.PATHAO_CLIENT_SECRET &&
  process.env.PATHAO_USERNAME &&
  process.env.PATHAO_PASSWORD;
const steadfastKey = process.env.STEADFAST_API_KEY && process.env.STEADFAST_API_SECRET;

const logisticsConfig: LogisticsConfigSection = {
  logistics: {
    defaultProvider: (process.env.LOGISTICS_DEFAULT_PROVIDER || 'redx') as 'redx' | 'pathao' | 'steadfast',
    providers: {
      ...(redxKey
        ? {
            redx: {
              apiUrl: process.env.REDX_API_URL || 'https://sandbox.redx.com.bd/v1.0.0-beta',
              apiKey: redxKey,
              isSandbox: (process.env.REDX_API_URL || '').includes('sandbox'),
              ...(process.env.REDX_DEFAULT_PICKUP_STORE_ID
                ? { defaultPickupStoreId: Number(process.env.REDX_DEFAULT_PICKUP_STORE_ID) }
                : {}),
            },
          }
        : {}),
      ...(pathaoCreds
        ? {
            pathao: {
              apiUrl: process.env.PATHAO_API_URL || 'https://courier-api-sandbox.pathao.com',
              clientId: process.env.PATHAO_CLIENT_ID!,
              clientSecret: process.env.PATHAO_CLIENT_SECRET!,
              username: process.env.PATHAO_USERNAME!,
              password: process.env.PATHAO_PASSWORD!,
              ...(process.env.PATHAO_DEFAULT_STORE_ID
                ? { defaultStoreCode: Number(process.env.PATHAO_DEFAULT_STORE_ID) }
                : {}),
              isSandbox: (process.env.PATHAO_API_URL || '').includes('sandbox'),
            },
          }
        : {}),
      ...(steadfastKey
        ? {
            steadfast: {
              apiUrl: process.env.STEADFAST_API_URL,
              apiKey: process.env.STEADFAST_API_KEY!,
              apiSecret: process.env.STEADFAST_API_SECRET!,
            },
          }
        : {}),
    },
  },
};

export default logisticsConfig;
