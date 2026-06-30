/**
 * Host-local CRM port types.
 *
 * `@classytic/crm` 0.5.0 became an engine-factory package: `createCrm()`
 * returns Mongoose-backed `Repository` subclasses bound to the package's OWN
 * models/collections, and the old plain-object entity DTOs + injectable
 * port/adapter/service layer (`Account`, `AccountFilter`, `AccountRepository`,
 * `AccountService`, …) were removed (PACKAGE_RULES "repository-as-API; no
 * service-per-repo; no port-adapter layer").
 *
 * be-prod, however, stores CRM data in its OWN collections (`crm_leads`,
 * `crm_opportunities`, …) and projects its `customers` collection as the CRM
 * contact store — so it cannot adopt the package's foreign models without an
 * on-disk data migration. We therefore keep be-prod's models + arc resources
 * and re-host the small port + service surface here, delegating the still-valid
 * domain primitives (`CRM_EVENTS`, `canTransition*` state-machine guards,
 * status enums, `crmEventDefinitions`) to the package.
 *
 * These types mirror the shapes the package used to export so the existing
 * `*-repository.adapter.ts` files and the engine wiring compile unchanged.
 */

import type { ActivityStatus, ActivityType, LeadStatus, OpportunityStatus, SubjectKind } from '@classytic/crm';
import type { ContactInfo, PersonName } from '@classytic/primitives/person';

// ── Shared value objects ────────────────────────────────────────────

export interface Money {
  amount: number;
  currency: string;
}

// ── Lead ────────────────────────────────────────────────────────────

export interface LeadStatusEntry {
  status: LeadStatus;
  occurredAt: Date;
  by?: string;
  note?: string;
}

export interface Lead {
  id: string;
  firstName?: string;
  lastName?: string;
  fullName: string;
  email?: string;
  phone?: string;
  companyName?: string;
  jobTitle?: string;
  source?: string;
  campaignRef?: string;
  score?: number;
  status: LeadStatus;
  statusHistory: LeadStatusEntry[];
  ownerId?: string;
  tags?: string[];
  convertedContactId?: string;
  convertedAccountId?: string;
  convertedOpportunityId?: string;
  convertedAt?: Date;
  disqualifyReason?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface LeadFilter {
  status?: LeadStatus | LeadStatus[];
  ownerId?: string;
  source?: string;
  minScore?: number;
}

export interface LeadRepository {
  findById(id: string): Promise<Lead | null>;
  findByEmail(email: string): Promise<Lead | null>;
  list(filter?: LeadFilter): Promise<Lead[]>;
  create(input: Partial<Lead> & { fullName: string; statusHistory: LeadStatusEntry[]; tags?: string[] }): Promise<Lead>;
  update(id: string, patch: Partial<Lead>): Promise<Lead>;
  casStatus(id: string, expected: LeadStatus, next: LeadStatus, patch?: Partial<Lead>): Promise<Lead | null>;
}

// ── Account ─────────────────────────────────────────────────────────

export interface Account {
  id: string;
  name: string;
  domain?: string;
  industry?: string;
  sizeBucket?: string;
  annualRevenue?: Money;
  ownerId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface AccountFilter {
  ownerId?: string;
  industry?: string;
  domain?: string;
  tags?: string[];
}

export interface AccountRepository {
  findById(id: string): Promise<Account | null>;
  findByDomain(domain: string): Promise<Account | null>;
  list(filter?: AccountFilter): Promise<Account[]>;
  create(input: Partial<Account> & { name: string }): Promise<Account>;
  update(id: string, patch: Partial<Account>): Promise<Account>;
  delete(id: string): Promise<void>;
}

// ── Contact ─────────────────────────────────────────────────────────

export interface Contact {
  id: string;
  name: PersonName;
  contact: ContactInfo;
  accountId?: string;
  ownerId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContactFilter {
  email?: string;
  ownerId?: string;
  accountId?: string;
  tags?: string[];
}

export interface ContactRepository {
  findById(id: string): Promise<Contact | null>;
  findByEmail(email: string): Promise<Contact | null>;
  list(filter?: ContactFilter): Promise<Contact[]>;
  create(input: {
    name: PersonName;
    contact?: ContactInfo;
    jobTitle?: string;
    accountId?: string;
    ownerId?: string;
    tags?: string[];
  }): Promise<Contact>;
  update(id: string, patch: Partial<Contact>): Promise<Contact>;
  delete(id: string): Promise<void>;
}

// ── Opportunity ─────────────────────────────────────────────────────

export interface OpportunityStatusEntry {
  status: OpportunityStatus;
  stageId?: string;
  occurredAt: Date;
  by?: string;
  note?: string;
}

export interface Opportunity {
  id: string;
  name: string;
  accountId?: string;
  primaryContactId?: string;
  pipelineId: string;
  stageId: string;
  status: OpportunityStatus;
  statusHistory: OpportunityStatusEntry[];
  amount?: Money;
  probability: number;
  expectedCloseAt?: Date;
  closedAt?: Date;
  lostReasonId?: string;
  ownerId?: string;
  sourceLeadId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpportunityFilter {
  status?: OpportunityStatus | OpportunityStatus[];
  pipelineId?: string;
  stageId?: string;
  ownerId?: string;
  accountId?: string;
  closingBetween?: { from: Date; to: Date };
}

export interface OpenOpportunityInput {
  name: string;
  pipelineId: string;
  stageId: string;
  accountId?: string;
  primaryContactId?: string;
  sourceLeadId?: string;
  amount?: Money;
  probability: number;
  expectedCloseAt?: Date;
  ownerId?: string;
  tags?: readonly string[];
  statusHistory: OpportunityStatusEntry[];
}

export interface OpportunityRepository {
  findById(id: string): Promise<Opportunity | null>;
  list(filter?: OpportunityFilter): Promise<Opportunity[]>;
  create(input: OpenOpportunityInput): Promise<Opportunity>;
  update(id: string, patch: Partial<Opportunity>): Promise<Opportunity>;
  delete(id: string): Promise<void>;
  casStatus(
    id: string,
    expected: OpportunityStatus,
    next: OpportunityStatus,
    patch?: Partial<Opportunity>,
  ): Promise<Opportunity | null>;
  casStage(
    id: string,
    expectedStageId: string,
    nextStageId: string,
    patch?: Partial<Opportunity>,
  ): Promise<Opportunity | null>;
}

// ── Pipeline ────────────────────────────────────────────────────────

export interface Stage {
  id: string;
  name: string;
  sequence: number;
  defaultProbability: number;
  color?: string;
  description?: string;
}

export interface Pipeline {
  id: string;
  name: string;
  isArchived: boolean;
  stages: Stage[];
  teamRef?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface PipelineRepository {
  findById(id: string): Promise<Pipeline | null>;
  list(includeArchived?: boolean): Promise<Pipeline[]>;
  create(input: {
    name: string;
    isArchived: boolean;
    stages: Stage[];
    teamRef?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Pipeline>;
  update(id: string, patch: Partial<Pipeline>): Promise<Pipeline>;
}

// ── Activity ────────────────────────────────────────────────────────

export interface Activity {
  id: string;
  type: ActivityType | string;
  status: ActivityStatus;
  subjectKind: SubjectKind;
  subjectId: string;
  subject?: string;
  body?: string;
  scheduledAt?: Date;
  completedAt?: Date;
  cancelledAt?: Date;
  ownerId?: string;
  participantIds?: string[];
  externalRef?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ActivityFilter {
  subjectKind?: SubjectKind;
  subjectId?: string;
  status?: ActivityStatus | ActivityStatus[];
  ownerId?: string;
  scheduledBetween?: { from: Date; to: Date };
}

export interface ActivityRepository {
  findById(id: string): Promise<Activity | null>;
  list(filter?: ActivityFilter): Promise<Activity[]>;
  create(input: Partial<Activity> & { type: string; subjectKind: SubjectKind; subjectId: string }): Promise<Activity>;
  update(id: string, patch: Partial<Activity>): Promise<Activity>;
  casStatus(
    id: string,
    expected: ActivityStatus,
    next: ActivityStatus,
    patch?: Partial<Activity>,
  ): Promise<Activity | null>;
}

// ── Note ────────────────────────────────────────────────────────────

export interface Note {
  id: string;
  subjectKind: SubjectKind;
  subjectId: string;
  body: string;
  format: 'plain' | 'markdown';
  authorId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface NoteRepository {
  findById(id: string): Promise<Note | null>;
  listBySubject(subjectKind: SubjectKind, subjectId: string): Promise<Note[]>;
  create(input: {
    subjectKind: SubjectKind;
    subjectId: string;
    body: string;
    format?: 'plain' | 'markdown';
    authorId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Note>;
  update(id: string, patch: Partial<Note>): Promise<Note>;
  delete(id: string): Promise<void>;
}

// ── LossReason ──────────────────────────────────────────────────────

export interface LossReason {
  id: string;
  name: string;
  active: boolean;
  category?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface LossReasonRepository {
  findById(id: string): Promise<LossReason | null>;
  list(activeOnly?: boolean): Promise<LossReason[]>;
  create(input: {
    name: string;
    active: boolean;
    category?: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }): Promise<LossReason>;
  update(id: string, patch: Partial<LossReason>): Promise<LossReason>;
}
