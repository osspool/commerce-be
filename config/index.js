// src/config/index.js
import { warnIfMissing } from "./utils.js"; // Import only warnIfMissing, not requiredEnv
import appConfig from "./sections/app.config.js";
import dbConfig from "./sections/db.config.js";
import storageConfig from "./sections/storage.config.js";
import emailConfig from "./sections/email.config.js";
// import googleConfig from "./sections/google.config.js";
// import stripeConfig from "./sections/stripe.config.js";
import posConfig from "./sections/pos.config.js";
import logisticsConfig from "./sections/logistics.config.js";
import costPriceConfig from "./sections/costPrice.config.js";


class Config {
  constructor() {
    this.env = process.env.NODE_ENV || process.env.ENV || "dev";
    // Environment variables should be loaded by env-loader.js before this file is imported
    this.validateCoreEnvs(); // Just validate non-critical envs

    console.log("Config loaded successfully: ", this.env);
  }

  validateCoreEnvs() {
    // MONGO_URI is now checked directly in db.js
    
    // Use warnIfMissing for non-critical but important variables
    warnIfMissing("JWT_SECRET");
    // Google Sheets key validation is handled within google.config.js now

    // Other specific validations are handled within their respective config section files
  }

  get config() {
    // Combine all the configuration sections
    const fullConfig = {
        env: this.env,
        isDevelopment: this.env === "dev",
        isProduction: this.env === "prod",
        isTest: this.env === "test" || this.env === "qa",
        ...appConfig,
        ...dbConfig,
        ...storageConfig,
        ...emailConfig,
        // ...googleConfig,
        // ...stripeConfig,
        ...posConfig,
        ...logisticsConfig,
        ...costPriceConfig,
    };

    return fullConfig;
  }
}

const config = new Config().config;

// Freeze the config object to prevent modifications
Object.freeze(config);
Object.freeze(config.app); // Deep freeze some key sections if needed
Object.freeze(config.db);
Object.freeze(config.google);
Object.freeze(config.stripe);
Object.freeze(config.pos);
Object.freeze(config.logistics);
Object.freeze(config.costPrice);
// Add more deep freezes for other sections if you want them immutable

export default config;
