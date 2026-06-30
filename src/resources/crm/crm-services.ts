/**
 * Host-local CRM service layer.
 *
 * `@classytic/crm` 0.5.x is an engine-factory package: domain verbs live on
 * the package's own Mongoose-backed repositories (`engine.repositories.*`),
 * and the old injectable `*Service` wrapper classes were removed — only
 * `LeadService` survives, and it is `fromEngine`-only (it orchestrates the
 * package's OWN repositories, not host adapters).
 *
 * be-prod stores CRM data in its OWN collections (`crm_leads`,
 * `crm_opportunities`, …) and projects `customers` as the contact store
 * (see ports.ts), so it cannot drive the package's repositories directly.
 * We therefore re-host the thin service surface here — composing be-prod's
 * local port adapters — and delegate the still-valid domain primitives
 * (`canTransition*` state-machine guards, `CRM_EVENTS`, `createEvent`) to the
 * package, exactly as 0.5.x intends ("compose repository calls at the host").
 *
 * These services expose the SAME verbs the host actions/resources call, so
 * the lead/opportunity/activity lifecycle surface the FE consumes is
 * unchanged from the 0.1.x wiring.
 */

import {
  CRM_EVENTS,
  type CrmContext,
  canTransitionActivity,
  canTransitionLead,
  canTransitionOpportunity,
  createEvent,
} from '@classytic/crm';
import type { DomainEvent, EventTransport } from '@classytic/primitives/events';
import type { ContactInfo, PersonName } from '@classytic/primitives/person';
import type {
  Account,
  AccountFilter,
  AccountRepository,
  ActivityRepository,
  Contact,
  ContactFilter,
  ContactRepository,
  Lead,
  LeadRepository,
  LeadStatusEntry,
  Opportunity,
  OpportunityRepository,
  OpportunityStatusEntry,
  PipelineRepository,
} from './ports.js';

/** Durable transactional-outbox surface (host-owned). */
interface OutboxLike {
  save(event: DomainEvent, options?: { session?: unknown }): Promise<void>;
}

/** Lead → Account/Contact/Opportunity convert input (host shape). */
export interface ConvertLeadInput {
  pipelineId: string;
  opportunityName?: string;
  amount?: { amount: number; currency: string };
  expectedCloseAt?: Date;
  by?: string;
}

export interface ConvertResult {
  lead: Lead;
  opportunity: Opportunity;
  contactId: string;
  accountId?: string;
  opportunityId: string;
}

function statusEntry(status: Lead['status'], by?: string, note?: string): LeadStatusEntry {
  return {
    status,
    occurredAt: new Date(),
    ...(by ? { by } : {}),
    ...(note ? { note } : {}),
  };
}

function oppStatusEntry(
  status: Opportunity['status'],
  stageId?: string,
  by?: string,
  note?: string,
): OpportunityStatusEntry {
  return {
    status,
    ...(stageId ? { stageId } : {}),
    occurredAt: new Date(),
    ...(by ? { by } : {}),
    ...(note ? { note } : {}),
  };
}

// ── Lead service ────────────────────────────────────────────────────

export interface LeadServiceDeps {
  lead: LeadRepository;
  contact: ContactRepository;
  account: AccountRepository;
  opportunity: OpportunityRepository;
  pipeline: PipelineRepository;
  events: EventTransport;
  outbox: OutboxLike;
}

/**
 * Lead lifecycle + conversion orchestrator. Wraps the host's lead adapter
 * for state transitions and composes the contact/account/opportunity
 * adapters for `convert` — the 0.5.x `LeadService.convert` equivalent over
 * be-prod's own models.
 */
export class LeadService {
  constructor(private readonly deps: LeadServiceDeps) {}

  private async transition(
    id: string,
    to: Lead['status'],
    patch: Partial<Lead>,
    note?: string,
    by?: string,
  ): Promise<Lead> {
    const current = await this.deps.lead.findById(id);
    if (!current) throw new Error(`Lead '${id}' not found`);
    if (current.status === to) return current;
    if (!canTransitionLead(current.status, to)) {
      throw new Error(`Invalid lead transition: ${current.status} → ${to}`);
    }
    const statusHistory = [...current.statusHistory, statusEntry(to, by, note)];
    const next = await this.deps.lead.casStatus(id, current.status, to, {
      ...patch,
      statusHistory,
    });
    if (!next) throw new Error(`Lead '${id}' status changed concurrently; retry`);
    return next;
  }

  markContacted(id: string, by?: string, note?: string): Promise<Lead> {
    return this.transition(id, 'contacted', {}, note, by);
  }

  qualify(id: string, by?: string, note?: string): Promise<Lead> {
    return this.transition(id, 'qualified', {}, note, by);
  }

  disqualify(id: string, reason: string, by?: string): Promise<Lead> {
    return this.transition(id, 'disqualified', { disqualifyReason: reason }, reason, by);
  }

  nurture(id: string, by?: string): Promise<Lead> {
    return this.transition(id, 'nurturing', {}, undefined, by);
  }

  /**
   * Convert a Lead into Account + Contact + Opportunity, then transition the
   * lead to `converted`. Emits `crm:lead.converted` through the durable
   * outbox so the commerce bridge fires at-least-once.
   */
  async convert(id: string, input: ConvertLeadInput, ctx: CrmContext): Promise<ConvertResult> {
    const lead = await this.deps.lead.findById(id);
    if (!lead) throw new Error(`Lead '${id}' not found`);
    if (lead.status === 'converted') throw new Error(`Lead '${id}' already converted`);
    if (lead.convertedOpportunityId) throw new Error(`Lead '${id}' already converted`);

    const pipeline = await this.deps.pipeline.findById(input.pipelineId);
    if (!pipeline) throw new Error(`Pipeline '${input.pipelineId}' not found`);
    const firstStage = [...pipeline.stages].sort((a, b) => a.sequence - b.sequence)[0];
    if (!firstStage) throw new Error(`Pipeline '${input.pipelineId}' has no stages`);

    // Account — only when the lead carries a company.
    let accountId: string | undefined;
    if (lead.companyName) {
      const account = await this.deps.account.create({
        name: lead.companyName,
        ...(lead.ownerId ? { ownerId: lead.ownerId } : {}),
      });
      accountId = account.id;
    }

    // Contact — projected into the customers collection.
    const contact = await this.deps.contact.create({
      name: { given: lead.firstName ?? lead.fullName, family: lead.lastName ?? '' },
      ...(lead.email || lead.phone
        ? { contact: { ...(lead.email ? { email: lead.email } : {}), ...(lead.phone ? { phone: lead.phone } : {}) } }
        : {}),
      ...(lead.jobTitle ? { jobTitle: lead.jobTitle } : {}),
      ...(accountId ? { accountId } : {}),
      ...(lead.ownerId ? { ownerId: lead.ownerId } : {}),
    });

    // Opportunity — opens in the pipeline's first stage.
    const opportunityName = input.opportunityName ?? `${lead.companyName ?? lead.fullName} — ${lead.source ?? 'New'}`;
    const opportunity = await this.deps.opportunity.create({
      name: opportunityName,
      pipelineId: input.pipelineId,
      stageId: firstStage.id,
      ...(accountId ? { accountId } : {}),
      primaryContactId: contact.id,
      sourceLeadId: lead.id,
      ...(input.amount ? { amount: input.amount } : {}),
      probability: firstStage.defaultProbability,
      ...(input.expectedCloseAt ? { expectedCloseAt: input.expectedCloseAt } : {}),
      ...(lead.ownerId ? { ownerId: lead.ownerId } : {}),
      statusHistory: [oppStatusEntry('open', firstStage.id, input.by)],
    });

    // Transition the lead to `converted`, stamping the cross-links.
    const converted = await this.transition(
      id,
      'converted',
      {
        convertedContactId: contact.id,
        ...(accountId ? { convertedAccountId: accountId } : {}),
        convertedOpportunityId: opportunity.id,
        convertedAt: new Date(),
      },
      undefined,
      input.by,
    );

    const event = createEvent(
      CRM_EVENTS.LEAD_CONVERTED,
      {
        leadId: id,
        contactId: contact.id,
        ...(accountId ? { accountId } : {}),
        opportunityId: opportunity.id,
      },
      ctx,
    );
    await this.deps.outbox.save(event);
    await this.deps.events.publish(event);

    return {
      lead: converted,
      opportunity,
      contactId: contact.id,
      ...(accountId ? { accountId } : {}),
      opportunityId: opportunity.id,
    };
  }
}

// ── Opportunity service ─────────────────────────────────────────────

export interface MoveStageInput {
  stageId: string;
  by?: string;
  note?: string;
  probability?: number;
}

export interface CloseInput {
  by?: string;
  note?: string;
  closedAt?: Date;
  amount?: { amount: number; currency: string };
  lostReasonId?: string;
}

export interface OpportunityServiceDeps {
  opportunity: OpportunityRepository;
  pipeline: PipelineRepository;
  events: EventTransport;
  outbox: OutboxLike;
}

export class OpportunityService {
  constructor(private readonly deps: OpportunityServiceDeps) {}

  /** Atomic stage move guarded on the current `stageId`. */
  async moveToStage(id: string, input: MoveStageInput): Promise<Opportunity> {
    const current = await this.deps.opportunity.findById(id);
    if (!current) throw new Error(`Opportunity '${id}' not found`);
    if (current.status !== 'open') throw new Error(`Opportunity '${id}' is not open`);
    if (current.stageId === input.stageId) return current;

    let probability = input.probability;
    if (probability === undefined) {
      const pipeline = await this.deps.pipeline.findById(current.pipelineId);
      const stage = pipeline?.stages.find((s) => s.id === input.stageId);
      probability = stage?.defaultProbability ?? current.probability;
    }

    const statusHistory = [...current.statusHistory, oppStatusEntry('open', input.stageId, input.by, input.note)];
    const next = await this.deps.opportunity.casStage(id, current.stageId, input.stageId, {
      probability,
      statusHistory,
    });
    if (!next) throw new Error(`Opportunity '${id}' stage changed concurrently; retry`);
    return next;
  }

  win(id: string, input: CloseInput = {}): Promise<Opportunity> {
    return this.close(id, 'won', input, CRM_EVENTS.OPPORTUNITY_WON);
  }

  lose(id: string, input: CloseInput = {}): Promise<Opportunity> {
    return this.close(id, 'lost', input, CRM_EVENTS.OPPORTUNITY_LOST);
  }

  async abandon(id: string, by?: string, note?: string): Promise<Opportunity> {
    return this.close(
      id,
      'abandoned',
      { ...(by ? { by } : {}), ...(note ? { note } : {}) },
      CRM_EVENTS.OPPORTUNITY_ABANDONED,
    );
  }

  private async close(
    id: string,
    to: Opportunity['status'],
    input: CloseInput,
    eventName: string,
  ): Promise<Opportunity> {
    const current = await this.deps.opportunity.findById(id);
    if (!current) throw new Error(`Opportunity '${id}' not found`);
    if (current.status === to) return current;
    if (!canTransitionOpportunity(current.status, to)) {
      throw new Error(`Invalid opportunity transition: ${current.status} → ${to}`);
    }

    const patch: Partial<Opportunity> = {
      closedAt: input.closedAt ?? new Date(),
      // crm 0.5.x close semantics: a won deal is 100% probable, a lost /
      // abandoned deal is 0% — the terminal status overrides whatever stage
      // default-probability the opportunity carried while open (matches
      // @classytic/crm OpportunityRepository.win/lose/abandon).
      probability: to === 'won' ? 1 : 0,
      statusHistory: [...current.statusHistory, oppStatusEntry(to, current.stageId, input.by, input.note)],
      ...(input.amount ? { amount: input.amount } : {}),
      ...(input.lostReasonId ? { lostReasonId: input.lostReasonId } : {}),
    };

    const next = await this.deps.opportunity.casStatus(id, current.status, to, patch);
    if (!next) throw new Error(`Opportunity '${id}' status changed concurrently; retry`);

    const payload: Record<string, unknown> = { opportunityId: id };
    if (to === 'won' && next.amount) payload.amount = next.amount.amount;
    if (to === 'lost' && next.lostReasonId) payload.lostReasonId = next.lostReasonId;

    const event = createEvent(eventName, payload);
    await this.deps.outbox.save(event);
    await this.deps.events.publish(event);
    return next;
  }
}

// ── Activity service ────────────────────────────────────────────────

export interface ActivityServiceDeps {
  activity: ActivityRepository;
  events: EventTransport;
  outbox: OutboxLike;
}

export class ActivityService {
  constructor(private readonly deps: ActivityServiceDeps) {}

  complete(id: string, completedAt?: Date): Promise<unknown> {
    return this.transition(id, 'completed', { completedAt: completedAt ?? new Date() });
  }

  cancel(id: string, reason?: string): Promise<unknown> {
    return this.transition(id, 'cancelled', {
      cancelledAt: new Date(),
      ...(reason ? { metadata: { cancelReason: reason } } : {}),
    });
  }

  private async transition(
    id: string,
    to: 'completed' | 'cancelled',
    patch: Record<string, unknown>,
  ): Promise<unknown> {
    const current = await this.deps.activity.findById(id);
    if (!current) throw new Error(`Activity '${id}' not found`);
    if (current.status === to) return current;
    if (!canTransitionActivity(current.status, to)) {
      throw new Error(`Invalid activity transition: ${current.status} → ${to}`);
    }
    const next = await this.deps.activity.casStatus(id, current.status, to, patch);
    if (!next) throw new Error(`Activity '${id}' status changed concurrently; retry`);
    return next;
  }
}

// ── Contact service ─────────────────────────────────────────────────
//
// crm 0.5.x removed the package's injectable ContactService; be-prod re-hosts
// the thin surface here over its own `customers`-backed contact adapter (the
// adapter already implements create/update/list/find). Verbs match the prior
// 0.1.x service so the host actions + crm-e2e contract are unchanged. Create/
// update emit the package's canonical CONTACT_* events through the host outbox.

export interface ContactServiceDeps {
  contact: ContactRepository;
  events: EventTransport;
  outbox: OutboxLike;
}

export class ContactService {
  constructor(private readonly deps: ContactServiceDeps) {}

  findById(id: string) {
    return this.deps.contact.findById(id);
  }

  findByEmail(email: string) {
    return this.deps.contact.findByEmail(email);
  }

  list(filter?: ContactFilter) {
    return this.deps.contact.list(filter);
  }

  async create(input: {
    name: PersonName;
    contact?: ContactInfo;
    jobTitle?: string;
    accountId?: string;
    ownerId?: string;
    tags?: string[];
  }) {
    const created = await this.deps.contact.create(input);
    await this.emit(CRM_EVENTS.CONTACT_CREATED, { contactId: created.id });
    return created;
  }

  async update(id: string, patch: Partial<Contact>) {
    const updated = await this.deps.contact.update(id, patch);
    await this.emit(CRM_EVENTS.CONTACT_UPDATED, { contactId: id });
    return updated;
  }

  private async emit(name: string, payload: Record<string, unknown>): Promise<void> {
    const event = createEvent(name, payload);
    await this.deps.outbox.save(event);
    await this.deps.events.publish(event);
  }
}

// ── Account service ─────────────────────────────────────────────────
//
// Same re-host rationale as ContactService. Accounts are branch-scoped by the
// adapter's `organizationId` context, which the crm-e2e "Account collection is
// branch-scoped" assertion verifies.

export interface AccountServiceDeps {
  account: AccountRepository;
  events: EventTransport;
  outbox: OutboxLike;
}

export class AccountService {
  constructor(private readonly deps: AccountServiceDeps) {}

  findById(id: string) {
    return this.deps.account.findById(id);
  }

  findByDomain(domain: string) {
    return this.deps.account.findByDomain(domain);
  }

  list(filter?: AccountFilter) {
    return this.deps.account.list(filter);
  }

  async create(input: Partial<Account> & { name: string }) {
    const created = await this.deps.account.create(input);
    await this.emit(CRM_EVENTS.ACCOUNT_CREATED, { accountId: created.id });
    return created;
  }

  async update(id: string, patch: Partial<Account>) {
    const updated = await this.deps.account.update(id, patch);
    await this.emit(CRM_EVENTS.ACCOUNT_UPDATED, { accountId: id });
    return updated;
  }

  private async emit(name: string, payload: Record<string, unknown>): Promise<void> {
    const event = createEvent(name, payload);
    await this.deps.outbox.save(event);
    await this.deps.events.publish(event);
  }
}
