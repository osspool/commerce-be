/**
 * Client branding — the ONE file a fork edits for backend-facing identity.
 *
 * Fork model (like Odoo: separate deployment per client). This repo IS the
 * client; there is no multi-tenant selection. To brand a new fork, edit the
 * values below — that's it.
 *
 * Scope: only things that were previously HARDCODED with the BigBoss name.
 *   - which apps/modules are on  → src/deployment.config.ts  (separate concern)
 *   - payment methods / VAT / etc → bootstrap + PlatformConfig admin UI
 *   - secrets                     → .env
 *
 * Consumers (replace the hardcoded "BigBoss" at each):
 *   - PLATFORM_NAME / notifications "from"   → clientConfig.name
 *   - invoice PDF header (pdf.bridge.ts)     → clientConfig.legalName + logoUrl
 */

export interface ClientConfig {
  /** Short brand name — emails, notifications, invoice header. */
  name: string;
  /** Legal entity — invoices, tax filings. */
  legalName: string;
  supportEmail: string;
  supportPhone?: string;
  /** Public-facing logo URL or path used on generated documents (invoices). */
  logoUrl?: string;
  storefrontUrl?: string;
}

export const clientConfig: ClientConfig = {
  name: 'BigBoss',
  legalName: 'BigBoss Retail Ltd.',
  supportEmail: 'support@bigboss.com.bd',
  supportPhone: '+8801700000000',
  logoUrl: 'https://bigboss.com.bd/logo.svg',
  storefrontUrl: 'https://bigboss.com.bd',
};

export default clientConfig;
