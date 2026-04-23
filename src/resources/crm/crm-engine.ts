/**
 * CRM engine factory — constructs `@classytic/crm` services per-request.
 *
 * Why per-request (and not a singleton like Flow): CRM services close over
 * repositories that are scoped to a branch via `organizationId`. Sharing a
 * single service instance across branches would require threading scope
 * through every call site. Building services per-request is cheap — they're
 * thin wrappers around repository adapters — and it keeps CRM's service
 * layer branch-agnostic.
 *
 * Every port is now backed by a Mongoose-backed adapter; no in-memory
 * reference repositories remain in the hot path.
 */

import {
  AccountService,
  ActivityService,
  ContactService,
  LeadService,
  OpportunityService,
  PipelineService,
} from '@classytic/crm';
import type { EventTransport } from '@classytic/primitives/events';
import config from '#config/index.js';
import { eventTransport } from '#lib/events/EventBus.js';
import { outboxStore } from '#shared/outbox/index.js';
import { createAccountRepositoryAdapter } from './accounts/account-repository.adapter.js';
import { createActivityRepositoryAdapter } from './activities/activity-repository.adapter.js';
import { createContactRepositoryAdapter } from './contact/contact-repository.adapter.js';
import type { CrmRequestContext } from './context-helpers.js';
import { createLeadRepositoryAdapter } from './leads/lead-repository.adapter.js';
import { createNoteRepositoryAdapter } from './notes/note-repository.adapter.js';
import { createOpportunityRepositoryAdapter } from './opportunities/opportunity-repository.adapter.js';
import { createPipelineRepositoryAdapter } from './pipelines/pipeline-repository.adapter.js';

export interface CrmServices {
  contacts: ContactService;
  accounts: AccountService;
  leads: LeadService;
  opportunities: OpportunityService;
  pipelines: PipelineService;
  activities: ActivityService;
}

export function buildCrmServices(ctx: CrmRequestContext): CrmServices | null {
  if (config.crm.mode === 'off') return null;

  const events: EventTransport = eventTransport as unknown as EventTransport;
  // Host-owned transactional outbox — events durably persisted alongside
  // business writes, then the relay delivers at-least-once to the 3 CRM
  // event consumers (crm.events.ts: lead.converted / opportunity.won /
  // opportunity.lost) even if the transport is down.
  const outbox = outboxStore;

  const contacts = new ContactService({
    repo: createContactRepositoryAdapter(ctx),
    events,
    outbox,
  });

  const accounts = new AccountService({
    repo: createAccountRepositoryAdapter(ctx),
    events,
    outbox,
  });

  const pipelines = new PipelineService({
    repo: createPipelineRepositoryAdapter(ctx),
    events,
    outbox,
  });

  const opportunities = new OpportunityService({
    repo: createOpportunityRepositoryAdapter(ctx),
    pipelines,
    events,
    outbox,
  });

  const leads = new LeadService({
    repo: createLeadRepositoryAdapter(ctx),
    contacts,
    accounts,
    opportunities,
    events,
    outbox,
  });

  const activities = new ActivityService({
    repo: createActivityRepositoryAdapter(ctx),
    notes: createNoteRepositoryAdapter(ctx),
    events,
    outbox,
  });

  return { contacts, accounts, leads, opportunities, pipelines, activities };
}
