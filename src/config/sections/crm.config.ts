/**
 * CRM engine configuration.
 *
 * Single switch — `enabled`. Full feature set ships when on: contacts,
 * accounts, activities, notes, leads, opportunities, scoring, forecasting.
 * Hide individual entities in the FE/permissions for tenants who only use
 * a subset.
 *
 * `organizationId = branchId` scoping matches the rest of the platform.
 */
export interface CrmConfigSection {
  crm: {
    enabled: boolean;
  };
}

const crmConfig: CrmConfigSection = {
  crm: {
    enabled: process.env.ENABLE_CRM === 'true',
  },
};

export default crmConfig;
