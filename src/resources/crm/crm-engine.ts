/**
 * CRM service factory — constructs the host-local CRM service bundle
 * per-request.
 *
 * `@classytic/crm` 0.5.x is an engine-factory package: `createCrm(config)`
 * returns an engine whose REPOSITORIES are the API surface
 * (`engine.repositories.{lead,opportunity,…}`), and the old injectable
 * `*Service` wrapper classes were removed — `LeadService` is the only
 * survivor and it is `fromEngine`-only (it drives the PACKAGE'S own models,
 * not host adapters).
 *
 * be-prod keeps its OWN models/collections and projects `customers` as the
 * contact store (see ports.ts), so it cannot adopt the package's foreign
 * repositories without an on-disk migration. We therefore re-host the thin
 * service surface in `crm-services.ts` — composing be-prod's local port
 * adapters — and delegate the still-valid domain primitives to the package.
 *
 * Why per-request (and not a singleton like Flow): the services close over
 * repository adapters scoped to a branch via `organizationId`. Building them
 * per-request is cheap — they're thin wrappers around repository adapters —
 * and keeps the service layer branch-agnostic.
 */

import type { EventTransport } from '@classytic/primitives/events';
import config from '#config/index.js';
import { eventTransport } from '#lib/events/EventBus.js';
import { outboxStore } from '#shared/outbox/index.js';
import { createAccountRepositoryAdapter } from './accounts/account-repository.adapter.js';
import { createActivityRepositoryAdapter } from './activities/activity-repository.adapter.js';
import { createContactRepositoryAdapter } from './contact/contact-repository.adapter.js';
import type { CrmRequestContext } from './context-helpers.js';
import {
  AccountService,
  ActivityService,
  ContactService,
  LeadService,
  OpportunityService,
} from './crm-services.js';
import { createLeadRepositoryAdapter } from './leads/lead-repository.adapter.js';
import { createOpportunityRepositoryAdapter } from './opportunities/opportunity-repository.adapter.js';
import { createPipelineRepositoryAdapter } from './pipelines/pipeline-repository.adapter.js';

export interface CrmServices {
  contacts: ContactService;
  accounts: AccountService;
  leads: LeadService;
  opportunities: OpportunityService;
  activities: ActivityService;
}

export function buildCrmServices(ctx: CrmRequestContext): CrmServices | null {
  if (!config.crm.enabled) return null;

  const events: EventTransport = eventTransport as unknown as EventTransport;
  // Host-owned transactional outbox — events durably persisted alongside
  // business writes, then the relay delivers at-least-once to the CRM event
  // consumers (crm.events.ts: lead.converted / opportunity.won /
  // opportunity.lost) even if the transport is down.
  const outbox = outboxStore;

  const pipeline = createPipelineRepositoryAdapter(ctx);

  // crm 0.5.x dropped the package's ContactService/AccountService wrappers;
  // re-host the thin surface over be-prod's own customers-backed adapters so
  // the host's contact/account verbs (and the crm-e2e contract) keep working.
  const contacts = new ContactService({
    contact: createContactRepositoryAdapter(ctx),
    events,
    outbox,
  });

  const accounts = new AccountService({
    account: createAccountRepositoryAdapter(ctx),
    events,
    outbox,
  });

  const opportunities = new OpportunityService({
    opportunity: createOpportunityRepositoryAdapter(ctx),
    pipeline,
    events,
    outbox,
  });

  const leads = new LeadService({
    lead: createLeadRepositoryAdapter(ctx),
    contact: createContactRepositoryAdapter(ctx),
    account: createAccountRepositoryAdapter(ctx),
    opportunity: createOpportunityRepositoryAdapter(ctx),
    pipeline,
    events,
    outbox,
  });

  const activities = new ActivityService({
    activity: createActivityRepositoryAdapter(ctx),
    events,
    outbox,
  });

  return { contacts, accounts, leads, opportunities, activities };
}
