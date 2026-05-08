/**
 * CRM → Commerce event bridges.
 *
 * Keeps `@classytic/crm` decoupled from commerce: CRM publishes domain events
 * with package-prefixed names (`crm:*`); commerce subscribes and mutates its
 * own state. No cross-package imports.
 *
 * Currently wired bridges:
 * 1. `crm:lead.converted`     → flip Customer.crm.stage to 'prospect'
 * 2. `crm:opportunity.won`    → flip Customer.crm.stage to 'active'
 * 3. `crm:opportunity.lost`   → flip Customer.crm.stage to 'churned'
 *
 * Wired from `registerCrmEventBridges(eventTransport)` at app startup when
 * `config.crm.enabled` is true.
 */

import type { DomainEvent, EventHandler, EventTransport } from '@classytic/primitives/events';
import { CRM_EVENTS } from '@classytic/crm';
import pino from 'pino';
import customerRepository from '#resources/sales/customers/customer.repository.js';
import type { IOpportunityDoc } from './opportunities/opportunity.model.js';
import crmOpportunityRepository from './opportunities/opportunity.repository.js';

const log = pino({ name: 'crm-events' });

type CrmStage = 'lead' | 'prospect' | 'active' | 'churned';

interface LeadConvertedPayload {
  leadId: string;
  contactId: string;
  accountId?: string;
  opportunityId: string;
}

interface OpportunityTerminalPayload {
  opportunityId: string;
  /**
   * Included by manual publishes (tests / host actions). CRM's service layer
   * emits `{ opportunityId, amount }` without `contactId`, so the bridge
   * falls back to fetching the opportunity to find `primaryContactId`.
   */
  contactId?: string;
  accountId?: string;
}

async function resolveOpportunityContactId(payload: OpportunityTerminalPayload): Promise<string | null> {
  if (payload.contactId) return payload.contactId;
  if (!payload.opportunityId) return null;
  try {
    const Model = (
      crmOpportunityRepository as unknown as {
        Model: {
          findById: (id: string) => { lean: () => Promise<IOpportunityDoc | null> };
        };
      }
    ).Model;
    const opp = await Model.findById(payload.opportunityId).lean();
    return opp?.primaryContactId ?? null;
  } catch (err) {
    log.warn({ err, opportunityId: payload.opportunityId }, 'Failed to resolve primaryContactId from opportunity');
    return null;
  }
}

async function setCustomerStage(
  customerId: string,
  stage: CrmStage,
  extras: Record<string, unknown> = {},
): Promise<void> {
  try {
    await customerRepository.update(customerId, {
      'crm.stage': stage,
      ...extras,
    } as unknown as Parameters<typeof customerRepository.update>[1]);
  } catch (err) {
    log.error({ err, customerId, stage }, 'Failed to update customer crm.stage');
  }
}

export async function registerCrmEventBridges(transport: EventTransport): Promise<Array<() => void>> {
  const subLeadConverted: EventHandler = async (event: DomainEvent) => {
    const payload = event.payload as LeadConvertedPayload;
    if (!payload?.contactId) return;
    await setCustomerStage(payload.contactId, 'prospect', {
      'crm.convertedFromLeadId': payload.leadId,
    });
  };

  const subOpportunityWon: EventHandler = async (event: DomainEvent) => {
    const payload = event.payload as OpportunityTerminalPayload;
    const contactId = await resolveOpportunityContactId(payload);
    if (!contactId) return;
    await setCustomerStage(contactId, 'active', {
      'crm.lastContactedAt': new Date(),
    });
  };

  const subOpportunityLost: EventHandler = async (event: DomainEvent) => {
    const payload = event.payload as OpportunityTerminalPayload;
    const contactId = await resolveOpportunityContactId(payload);
    if (!contactId) return;
    await setCustomerStage(contactId, 'churned');
  };

  // Await all three subscriptions so callers can rely on bridges being live
  // before they return. Fire-and-forget subscribes leave a race window that
  // the integration test trips on.
  const unsubs = await Promise.all([
    transport.subscribe(CRM_EVENTS.LEAD_CONVERTED, subLeadConverted),
    transport.subscribe(CRM_EVENTS.OPPORTUNITY_WON, subOpportunityWon),
    transport.subscribe(CRM_EVENTS.OPPORTUNITY_LOST, subOpportunityLost),
  ]);

  log.info({ subscriptions: unsubs.length }, 'CRM event bridges registered');
  return unsubs;
}
