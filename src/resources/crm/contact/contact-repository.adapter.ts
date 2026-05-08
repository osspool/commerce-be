import type { Contact, ContactFilter, ContactRepository } from '@classytic/crm';
import type { ContactInfo, PersonName } from '@classytic/primitives/person';
import type { ICustomer } from '#resources/sales/customers/customer.model.js';
import customerRepository from '#resources/sales/customers/customer.repository.js';
import type { CrmRequestContext } from '../context-helpers.js';

interface MongooseDocumentLike {
  toObject?: (opts?: unknown) => Record<string, unknown>;
}

/**
 * Convert a Mongoose sub-document (or a plain object from `.lean()`) into a
 * plain object. Callers upstream can pass either — Mongoose documents hold
 * internal `$basePath`/`_doc` symbols that `toEqual` in tests rejects.
 */
function toPlain<T>(value: T): T {
  const maybe = value as unknown as MongooseDocumentLike | null | undefined;
  if (maybe && typeof maybe.toObject === 'function') {
    return maybe.toObject() as unknown as T;
  }
  return value;
}

/**
 * Projects a Customer document into CRM's `Contact` shape.
 *
 * Customer is the source of truth — the same document holds identity (name,
 * contact), commerce state (stats, membership, credit, BD VAT), and the CRM
 * projection (`crm.stage`, `crm.ownerId`, `crm.accountId`). This keeps one
 * write path and zero joins for the read-heavy Contact queries CRM performs.
 */
function toContact(c: ICustomer): Contact {
  return {
    id: (c._id as unknown as { toString(): string }).toString(),
    name: toPlain<PersonName>(c.name),
    contact: toPlain<ContactInfo>(c.contact),
    ...(c.crm?.accountId ? { accountId: c.crm.accountId } : {}),
    ...(c.crm?.ownerId ? { ownerId: c.crm.ownerId } : {}),
    ...(c.tags && c.tags.length ? { tags: [...c.tags] } : {}),
    metadata: {
      customerType: c.customerType,
      ...(c.userId ? { userId: c.userId.toString() } : {}),
      ...(c.crm?.stage ? { crmStage: c.crm.stage } : {}),
    },
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/**
 * Host-side `ContactRepository` adapter for `@classytic/crm`.
 *
 * Constructed per-request so branch scope (`organizationId`) is bound into
 * the adapter — matches how Flow resolves per-branch context.
 *
 * NOTE: branch scoping is NOT enforced here at the moment because the
 * `customers` collection is currently company-wide (matches the platform
 * convention for Products). If customer scoping per branch is introduced
 * later, tighten the queries here — no change needed in CRM's service layer.
 */
export function createContactRepositoryAdapter(_ctx: CrmRequestContext): ContactRepository {
  const repo = customerRepository;

  return {
    async findById(id) {
      const doc = await repo.getById(id);
      return doc ? toContact(doc as unknown as ICustomer) : null;
    },

    async findByEmail(email) {
      const normalized = email.toLowerCase().trim();
      const doc = await repo.getByQuery({ 'contact.email': normalized });
      return doc ? toContact(doc as unknown as ICustomer) : null;
    },

    async list(filter: ContactFilter = {}) {
      const query: Record<string, unknown> = {};
      if (filter.email) query['contact.email'] = filter.email.toLowerCase().trim();
      if (filter.ownerId) query['crm.ownerId'] = filter.ownerId;
      if (filter.accountId) query['crm.accountId'] = filter.accountId;
      if (filter.tags && filter.tags.length) query.tags = { $all: [...filter.tags] };
      const docs = await repo.findAll(query);
      return (docs as unknown as ICustomer[]).map(toContact);
    },

    async create(input) {
      const created = await repo.create({
        name: input.name,
        contact: input.contact ?? {},
        customerType: 'retail',
        isActive: true,
        creditEnabled: false,
        creditDays: 0,
        tags: input.tags ? [...input.tags] : [],
        crm: {
          stage: 'lead',
          ...(input.ownerId ? { ownerId: input.ownerId } : {}),
          ...(input.accountId ? { accountId: input.accountId } : {}),
        },
        isDiplomatic: false,
        isExemptNgo: false,
        isSezUnit: false,
        isRmgFactory: false,
      } as Partial<ICustomer>);
      return toContact(created as unknown as ICustomer);
    },

    async update(id, patch) {
      const mongoPatch: Record<string, unknown> = {};
      if (patch.name) mongoPatch.name = patch.name;
      if (patch.contact) mongoPatch.contact = patch.contact;
      if (patch.tags) mongoPatch.tags = [...patch.tags];
      if (patch.accountId !== undefined) mongoPatch['crm.accountId'] = patch.accountId;
      if (patch.ownerId !== undefined) mongoPatch['crm.ownerId'] = patch.ownerId;
      const updated = await repo.update(id, mongoPatch);
      return toContact(updated as unknown as ICustomer);
    },

    async delete(id) {
      await repo.delete(id);
    },
  };
}
