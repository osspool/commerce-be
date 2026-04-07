// src/config/index.ts
import { warnIfMissing } from './utils.js';
import appConfig from './sections/app.config.js';
import dbConfig from './sections/db.config.js';
import storageConfig from './sections/storage.config.js';
import emailConfig from './sections/email.config.js';
// import googleConfig from "./sections/google.config.js";
// import stripeConfig from "./sections/stripe.config.js";
import posConfig from './sections/pos.config.js';
import logisticsConfig from './sections/logistics.config.js';
import costPriceConfig from './sections/costPrice.config.js';
import workerConfig from './sections/worker.config.js';
import inventoryConfig from './sections/inventory.config.js';
import accountingConfig from './sections/accounting.config.js';
import notificationsConfig from './sections/notifications.config.js';

import type { AppConfigSection } from './sections/app.config.js';
import type { DbSectionConfig } from './sections/db.config.js';
import type { StorageConfigSection } from './sections/storage.config.js';
import type { EmailConfigSection } from './sections/email.config.js';
// import type { GoogleConfigSection } from "./sections/google.config.js";
// import type { StripeConfigSection } from "./sections/stripe.config.js";
import type { PosConfigSection } from './sections/pos.config.js';
import type { LogisticsConfigSection } from './sections/logistics.config.js';
import type { CostPriceConfigSection } from './sections/costPrice.config.js';
import type { WorkerConfigSection } from './sections/worker.config.js';
import type { InventoryConfigSection } from './sections/inventory.config.js';
import type { AccountingConfigSection } from './sections/accounting.config.js';
import type { NotificationConfigSection } from './sections/notifications.config.js';

export interface AppConfig
  extends AppConfigSection,
    DbSectionConfig,
    StorageConfigSection,
    EmailConfigSection,
    // GoogleConfigSection,
    // StripeConfigSection,
    PosConfigSection,
    LogisticsConfigSection,
    CostPriceConfigSection,
    WorkerConfigSection,
    InventoryConfigSection,
    AccountingConfigSection,
    NotificationConfigSection {
  env: string;
  isDevelopment: boolean;
  isProduction: boolean;
  isTest: boolean;
}

class Config {
  env: string;

  constructor() {
    this.env = process.env.NODE_ENV || process.env.ENV || 'dev';
    // Environment variables should be loaded by env-loader.js before this file is imported
    this.validateCoreEnvs(); // Just validate non-critical envs

    console.log('Config loaded successfully: ', this.env);
  }

  validateCoreEnvs(): void {
    // MONGO_URI is now checked directly in db.js

    // Use warnIfMissing for non-critical but important variables
    warnIfMissing('JWT_SECRET');
    // Google Sheets key validation is handled within google.config.js now

    // Other specific validations are handled within their respective config section files
  }

  get config(): AppConfig {
    // Combine all the configuration sections
    const fullConfig: AppConfig = {
      env: this.env,
      isDevelopment: this.env === 'dev',
      isProduction: this.env === 'prod',
      isTest: this.env === 'test' || this.env === 'qa',
      ...appConfig,
      ...dbConfig,
      ...storageConfig,
      ...emailConfig,
      // ...googleConfig,
      // ...stripeConfig,
      ...posConfig,
      ...logisticsConfig,
      ...costPriceConfig,
      ...workerConfig,
      ...inventoryConfig,
      ...accountingConfig,
      ...notificationsConfig,
    };

    return fullConfig;
  }
}

const config: AppConfig = new Config().config;

// Freeze the config object to prevent modifications
Object.freeze(config);
Object.freeze(config.app); // Deep freeze some key sections if needed
Object.freeze(config.db);
// Object.freeze(config.google);
// Object.freeze(config.stripe);
Object.freeze(config.sku);
Object.freeze(config.logistics);
Object.freeze(config.costPrice);
Object.freeze(config.worker);
Object.freeze(config.inventory);
Object.freeze(config.accounting);
Object.freeze(config.notifications);
// Add more deep freezes for other sections if you want them immutable

export default config;
