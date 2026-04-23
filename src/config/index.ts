// src/config/index.ts

import type { StreamlineConfigSection } from '../core/plugins/streamline.config.js';
import streamlineConfig from '../core/plugins/streamline.config.js';
import type { AccountingConfigSection } from './sections/accounting.config.js';
import accountingConfig from './sections/accounting.config.js';
import type { AppConfigSection } from './sections/app.config.js';
import appConfig from './sections/app.config.js';
import type { AuditConfigSection } from './sections/audit.config.js';
import auditConfig from './sections/audit.config.js';
import type { CostPriceConfigSection } from './sections/costPrice.config.js';
import costPriceConfig from './sections/costPrice.config.js';
import type { CrmConfigSection } from './sections/crm.config.js';
import crmConfig from './sections/crm.config.js';
import type { DbSectionConfig } from './sections/db.config.js';
import dbConfig from './sections/db.config.js';
import type { EmailConfigSection } from './sections/email.config.js';
import emailConfig from './sections/email.config.js';
import type { InventoryConfigSection } from './sections/inventory.config.js';
import inventoryConfig from './sections/inventory.config.js';
import type { InvoiceConfigSection } from './sections/invoice.config.js';
import invoiceConfig from './sections/invoice.config.js';
import type { LogisticsConfigSection } from './sections/logistics.config.js';
import logisticsConfig from './sections/logistics.config.js';
import type { NotificationConfigSection } from './sections/notifications.config.js';
import notificationsConfig from './sections/notifications.config.js';
// import type { GoogleConfigSection } from "./sections/google.config.js";
// import type { StripeConfigSection } from "./sections/stripe.config.js";
import type { PosConfigSection } from './sections/pos.config.js';
// import googleConfig from "./sections/google.config.js";
// import stripeConfig from "./sections/stripe.config.js";
import posConfig from './sections/pos.config.js';
import type { SalesConfigSection } from './sections/sales.config.js';
import salesConfig from './sections/sales.config.js';
import type { StorageConfigSection } from './sections/storage.config.js';
import storageConfig from './sections/storage.config.js';
import type { WorkerConfigSection } from './sections/worker.config.js';
import workerConfig from './sections/worker.config.js';
import { warnIfMissing } from './utils.js';

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
    InvoiceConfigSection,
    StreamlineConfigSection,
    NotificationConfigSection,
    AuditConfigSection,
    SalesConfigSection,
    CrmConfigSection {
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

    // Config loaded — env: this.env (logger not available at config init time)
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
      ...invoiceConfig,
      ...streamlineConfig,
      ...notificationsConfig,
      ...auditConfig,
      ...salesConfig,
      ...crmConfig,
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
Object.freeze(config.invoice);
Object.freeze(config.streamline);
Object.freeze(config.notifications);
Object.freeze(config.audit);
Object.freeze(config.audit.resources);
Object.freeze(config.sales);
Object.freeze(config.crm);

export default config;
