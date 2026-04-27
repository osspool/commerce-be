/**
 * CRM end-to-end integration.
 *
 * Verifies the three novel pieces the CRM refactor introduced:
 *
 * 1. **Contact projection** — CRM's `ContactRepository` port is fulfilled by
 *    a Mongoose adapter that reads / writes the `customers` collection.
 *    Creating a Contact via the service should materialise a Customer row
 *    with `crm.stage = 'lead'`; updating the Contact should mutate the
 *    same Customer.
 *
 * 2. **Branch scoping on native CRM collections** — `crm_accounts` queries
 *    must filter by `organizationId` so a second branch sees nothing.
 *
 * 3. **Event bridge** — publishing `crm:opportunity.won` must flip the
 *    underlying Customer's `crm.stage` to `active`.
 *
 * Runs under `vitest.replset.config.ts` — the event bus relay expects
 * transactional Mongo.
 */

import mongoose, { type Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';

let env: ScenarioEnv;

beforeAll(async () => {
  env = await bootScenarioApp({
    scenario: 'crm-e2e',
    env: { CRM_MODE: 'simple' },
  });
}, 120_000);

afterAll(async () => {
  if (env) await env.teardown();
});

describe('CRM ↔ Commerce integration', () => {
  it('Contact service writes project into the customers collection', async () => {
    const { buildCrmServices } = await import('#resources/crm/crm-engine.js');
    const services = buildCrmServices({ organizationId: env.orgId });
    expect(services).not.toBeNull();

    const contact = await services!.contacts.create({
      name: { given: 'Ada', family: 'Lovelace' },
      contact: { phone: '+8801700000001', email: 'ada@example.com' },
      tags: ['manual-seed'],
    });

    expect(contact.name).toEqual({ given: 'Ada', family: 'Lovelace' });
    expect(contact.contact.email).toBe('ada@example.com');

    // The underlying Customer document exists and carries the CRM projection.
    const Customer = (await import('#resources/sales/customers/customer.model.js')).default;
    const raw = await Customer.findById(contact.id).lean();
    expect(raw).toBeTruthy();
    expect(raw?.name.given).toBe('Ada');
    expect(raw?.contact.phone).toBe('+8801700000001');
    expect(raw?.crm?.stage).toBe('lead');
  });

  it('Contact update through CRM service mutates the same Customer row', async () => {
    const { buildCrmServices } = await import('#resources/crm/crm-engine.js');
    const services = buildCrmServices({ organizationId: env.orgId })!;

    const created = await services.contacts.create({
      name: { given: 'Grace', family: 'Hopper' },
      contact: { phone: '+8801700000002' },
    });

    await services.contacts.update(created.id, { tags: ['vip', 'early-adopter'] });

    const Customer = (await import('#resources/sales/customers/customer.model.js')).default;
    const raw = await Customer.findById(created.id).lean();
    expect(raw?.tags).toEqual(expect.arrayContaining(['vip', 'early-adopter']));
  });

  it('Account collection is branch-scoped', async () => {
    const { buildCrmServices } = await import('#resources/crm/crm-engine.js');
    const services = buildCrmServices({ organizationId: env.orgId })!;
    const other = buildCrmServices({ organizationId: new mongoose.Types.ObjectId().toString() })!;

    await services.accounts.create({ name: 'BranchA Account', domain: 'branch-a.example.com' });

    const ownList = await services.accounts.list();
    const foreignList = await other.accounts.list();
    expect(ownList.map((a) => a.name)).toContain('BranchA Account');
    expect(foreignList.map((a) => a.name)).not.toContain('BranchA Account');
  });

  it('crm:opportunity.won bridge flips the underlying Customer stage to "active"', async () => {
    const { buildCrmServices } = await import('#resources/crm/crm-engine.js');
    const { registerCrmEventBridges } = await import('#resources/crm/crm.events.js');
    const { eventTransport } = await import('#lib/events/EventBus.js');
    const { CRM_EVENTS } = await import('@classytic/crm');
    const Customer = (await import('#resources/sales/customers/customer.model.js')).default;

    const services = buildCrmServices({ organizationId: env.orgId })!;

    const contact = await services.contacts.create({
      name: { given: 'Margaret', family: 'Hamilton' },
      contact: { phone: '+8801700000003' },
    });

    // Bridges are registered by the CRM plugin at app boot, but re-register
    // here to make the test self-contained when run in isolation.
    await registerCrmEventBridges(eventTransport);

    await eventTransport.publish({
      type: CRM_EVENTS.OPPORTUNITY_WON,
      payload: { opportunityId: 'opp-1', contactId: contact.id },
      meta: {
        id: new mongoose.Types.ObjectId().toString(),
        timestamp: new Date(),
      },
    });

    const raw = await Customer.findById(contact.id).lean();
    expect(raw?.crm?.stage).toBe('active');
    expect(raw?.crm?.lastContactedAt).toBeInstanceOf(Date);
  });

  it('crm:lead.converted bridge flips the stage to "prospect" and links the lead id', async () => {
    const { buildCrmServices } = await import('#resources/crm/crm-engine.js');
    const { registerCrmEventBridges } = await import('#resources/crm/crm.events.js');
    const { eventTransport } = await import('#lib/events/EventBus.js');
    const { CRM_EVENTS } = await import('@classytic/crm');
    const Customer = (await import('#resources/sales/customers/customer.model.js')).default;

    const services = buildCrmServices({ organizationId: env.orgId })!;

    const contact = await services.contacts.create({
      name: { given: 'Katherine', family: 'Johnson' },
      contact: { phone: '+8801700000004' },
    });

    await registerCrmEventBridges(eventTransport);

    await eventTransport.publish({
      type: CRM_EVENTS.LEAD_CONVERTED,
      payload: {
        leadId: 'lead-xyz',
        contactId: contact.id,
        opportunityId: 'opp-xyz',
      },
      meta: {
        id: new mongoose.Types.ObjectId().toString(),
        timestamp: new Date(),
      },
    });

    const raw = await Customer.findById(contact.id).lean() as {
      crm?: { stage?: string; convertedFromLeadId?: string };
    } | null;
    expect(raw?.crm?.stage).toBe('prospect');
    expect(raw?.crm?.convertedFromLeadId).toBe('lead-xyz');
  });
});

// Keep TypeScript happy about the `raw?.name.given` access in the first test
// — Mongoose `.lean()` returns a loosely-typed doc here.
type _Unused = Types.ObjectId;
