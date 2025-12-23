/**
 * Supplier Flow Integration Tests
 *
 * Ensures suppliers can be created, updated, and deactivated
 * with repository validation and code generation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import Supplier from '../../modules/commerce/inventory/supplier/supplier.model.js';
import supplierRepository from '../../modules/commerce/inventory/supplier/supplier.repository.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/bigboss-test';

describe('Supplier Flow', () => {
  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Supplier.deleteMany({});
  });

  it('creates supplier with auto-generated code', async () => {
    const supplier = await supplierRepository.create({
      name: 'Test Supplier',
      paymentTerms: 'credit',
      creditDays: 7,
    });

    expect(supplier.name).toBe('Test Supplier');
    expect(supplier.code).toMatch(/^SUP-\d{4}$/);
  });

  it('updates supplier fields', async () => {
    const supplier = await supplierRepository.create({
      name: 'Supplier Update',
    });

    const updated = await supplierRepository.update(supplier._id, {
      phone: '01712345678',
      isActive: true,
    });

    expect(updated.phone).toBe('01712345678');
  });

  it('deactivates supplier', async () => {
    const supplier = await supplierRepository.create({
      name: 'Supplier Deactivate',
    });

    await supplierRepository.update(supplier._id, { isActive: false });
    const refreshed = await supplierRepository.getById(supplier._id, { lean: true });

    expect(refreshed.isActive).toBe(false);
  });
});
