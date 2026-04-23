/**
 * CRM collection name registry.
 *
 * Per mongokit Rule 20 — collection names are explicit, never derived from
 * Mongoose's pluralizer. Every `mongoose.model(name, schema, COLLECTION)`
 * call in this module uses one of these constants.
 */
export const CRM_COLLECTIONS = {
  Account: 'crm_accounts',
  Lead: 'crm_leads',
  Opportunity: 'crm_opportunities',
  Activity: 'crm_activities',
  Note: 'crm_notes',
  Pipeline: 'crm_pipelines',
  LossReason: 'crm_loss_reasons',
} as const;
