/**
 * Quotation → Order integration test.
 *
 * Exercises the full FSM path: create draft → send → accept → convertToOrder.
 * Proves the order engine's `modules.quotation: true` flag is wired in
 * be-prod's engine and that the convertToOrder() verb actually produces
 * an Order document.
 *
 * Engine-level test (no HTTP) — the resource's FSM actions are thin
 * passthroughs; if the repo works, the resource works. Full HTTP coverage
 * lives in the broader `orders-e2e` harness.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createOrder } from '@classytic/order';
import type { OrderEngine, OrderContext } from '@classytic/order';

let replSet: MongoMemoryReplSet;
let connection: mongoose.Connection;
let engine: OrderEngine;

const ORG = 'branch-test-quote-001';

const ctx = (orgId = ORG): OrderContext => ({
  organizationId: orgId,
  actorRef: 'test-user',
  actorKind: 'user',
  correlationId: 'test-correlation',
});

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  connection = mongoose.createConnection(replSet.getUri());
  await connection.asPromise();

  // Stub catalog bridge — required by createOrder(). The quote → order
  // conversion doesn't touch catalog (the Order is built from quote line
  // snapshots), so returning fixed prices is fine for this test.
  const stubCatalog = {
    async resolveLine(input: { offerId?: string; sku?: string }) {
      return {
        skuRef: input.offerId ?? input.sku ?? 'stub-sku',
        name: 'Stub Item',
        unitPrice: { amount: 1000, currency: 'BDT' },
        requiresShipping: true,
        metadata: {},
      };
    },
  };

  engine = await createOrder({
    connection,
    defaultCurrency: 'BDT',
    multiTenant: false,
    autoIndex: true,
    tenantFieldType: 'string',
    modules: { quotation: true },
    idPrefixes: { quotation: 'QUO' },
    bridges: { catalog: stubCatalog as never },
  });
}, 60_000);

afterAll(async () => {
  await engine?.destroy?.();
  await connection?.close();
  await replSet?.stop();
});

describe('Quotation → Order conversion', () => {
  it('engine exposes Quotation model + quotation repository when module is enabled', () => {
    expect(engine.models.Quotation).toBeTruthy();
    expect(engine.repositories.quotation).toBeTruthy();
  });

  it('creates a draft quotation with line snapshots and zero totals (no bridges)', async () => {
    const quo = await engine.repositories.quotation!.create(
      {
        organizationId: ORG,
        orderType: 'standard',
        channel: 'b2b',
        customerId: 'cust-001',
        customerSnapshot: { name: 'Acme Ltd', email: 'ops@acme.test' },
        actorRef: 'test-user',
        actorKind: 'user',
        lines: [
          {
            kind: 'sku',
            offerId: 'sku-alpha',
            quantity: 3,
            unitPriceOverride: { amount: 10000, currency: 'BDT' },
            snapshot: {
              sku: 'sku-alpha',
              name: 'Widget',
              unitPrice: 10000,
              currency: 'BDT',
              requiresShipping: true,
            },
          },
        ],
      },
      { organizationId: ORG },
    );

    expect(quo.status).toBe('draft');
    expect(quo.quotationNumber).toMatch(/^QUO-\d{4}-\d{4}$/);
    expect(quo.lines).toHaveLength(1);
    expect(quo.lines[0].quantity).toBe(3);
    expect(quo.lines[0].lineTotal.amount).toBe(30000);
  });

  it('FSM: draft → sent → accepted → converted produces a linked Order', async () => {
    const quo = await engine.repositories.quotation!.create(
      {
        organizationId: ORG,
        orderType: 'standard',
        channel: 'b2b',
        customerId: 'cust-002',
        customerSnapshot: { name: 'Beta Inc', email: 'ap@beta.test' },
        lines: [
          {
            kind: 'sku',
            offerId: 'sku-beta',
            quantity: 1,
            unitPriceOverride: { amount: 50000, currency: 'BDT' },
            snapshot: {
              sku: 'sku-beta',
              name: 'Gadget',
              unitPrice: 50000,
              currency: 'BDT',
              requiresShipping: true,
            },
          },
        ],
      },
      { organizationId: ORG },
    );

    const sent = await engine.repositories.quotation!.send(quo.quotationNumber, ctx());
    expect(sent.status).toBe('sent');
    expect(sent.sentAt).toBeTruthy();

    const accepted = await engine.repositories.quotation!.accept(quo.quotationNumber, ctx());
    expect(accepted.status).toBe('accepted');
    expect(accepted.acceptedAt).toBeTruthy();

    const { quotation: converted, order } = await engine.repositories.quotation!.convertToOrder(
      quo.quotationNumber,
      {},
      ctx(),
    );
    expect(converted.status).toBe('converted');
    expect(converted.convertedOrderNumber).toBeTruthy();
    expect((order as { orderNumber: string }).orderNumber).toMatch(/^ORD-\d{4}-\d{4}$/);
    expect(converted.convertedOrderNumber).toBe((order as { orderNumber: string }).orderNumber);
  });

  it('rejects double-convert (idempotency)', async () => {
    const quo = await engine.repositories.quotation!.create(
      {
        organizationId: ORG,
        customerId: 'cust-003',
        customerSnapshot: { name: 'Idem Co', email: 'x@idem.test' },
        lines: [
          {
            kind: 'sku',
            offerId: 'sku-idem',
            quantity: 1,
            unitPriceOverride: { amount: 5000, currency: 'BDT' },
            snapshot: {
              sku: 'sku-idem',
              name: 'Thing',
              unitPrice: 5000,
              currency: 'BDT',
              requiresShipping: true,
            },
          },
        ],
      },
      { organizationId: ORG },
    );

    await engine.repositories.quotation!.send(quo.quotationNumber, ctx());
    await engine.repositories.quotation!.accept(quo.quotationNumber, ctx());
    await engine.repositories.quotation!.convertToOrder(quo.quotationNumber, {}, ctx());

    await expect(
      engine.repositories.quotation!.convertToOrder(quo.quotationNumber, {}, ctx()),
    ).rejects.toMatchObject({ code: 'QUOTATION_ALREADY_CONVERTED' });
  });

  it('FSM: rejected is terminal — cannot be re-accepted', async () => {
    const quo = await engine.repositories.quotation!.create(
      {
        organizationId: ORG,
        customerId: 'cust-004',
        customerSnapshot: { name: 'Rej Co', email: 'r@rej.test' },
        lines: [
          {
            kind: 'sku',
            offerId: 'sku-rej',
            quantity: 1,
            unitPriceOverride: { amount: 1000, currency: 'BDT' },
            snapshot: {
              sku: 'sku-rej',
              name: 'Cheap',
              unitPrice: 1000,
              currency: 'BDT',
              requiresShipping: true,
            },
          },
        ],
      },
      { organizationId: ORG },
    );

    await engine.repositories.quotation!.send(quo.quotationNumber, ctx());
    await engine.repositories.quotation!.reject(quo.quotationNumber, 'too expensive', ctx());

    await expect(
      engine.repositories.quotation!.accept(quo.quotationNumber, ctx()),
    ).rejects.toMatchObject({ code: 'QUOTATION_ALREADY_TERMINAL' });
  });
});
