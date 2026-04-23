/**
 * CRM engine configuration.
 *
 * Mode gate (mirror of FLOW_MODE):
 * - 'off'      — CRM routes, collections, and event subscribers are not wired.
 * - 'simple'   — Core entities enabled (contacts, accounts, activities, notes).
 * - 'standard' — Full pipeline (leads, opportunities, scoring, forecasting).
 *
 * `organizationId = branchId` scoping matches the rest of the platform.
 */
export type CrmMode = 'off' | 'simple' | 'standard';

const VALID_MODES: CrmMode[] = ['off', 'simple', 'standard'];

function parseCrmMode(value: string | undefined): CrmMode {
  if (value && VALID_MODES.includes(value as CrmMode)) return value as CrmMode;
  return 'off';
}

export interface CrmConfigSection {
  crm: {
    mode: CrmMode;
  };
}

const crmConfig: CrmConfigSection = {
  crm: {
    mode: parseCrmMode(process.env.CRM_MODE),
  },
};

export default crmConfig;
