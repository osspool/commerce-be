/**
 * Supplier Resource Definition
 */

import type { IController } from '@classytic/arc';
import { defineResource } from '@classytic/arc';
import permissions from '#config/permissions.js';
import { createAdapter } from '#shared/adapter.js';
import Supplier from './models/supplier.model.js';
import supplierController from './supplier.controller.js';
import supplierRepository from './supplier.repository.js';
import supplierSchemas, { supplierEntitySchema, supplierSchemaOptions } from './supplier.schemas.js';

const supplierResource = defineResource({
  name: 'supplier',
  audit: true,
  displayName: 'Suppliers',
  tag: 'Inventory - Suppliers',
  prefix: '/inventory/suppliers',
  adapter: createAdapter(Supplier, supplierRepository),
  // BaseController<AnyRecord> is structurally compatible with IController but
  // TypeScript cannot verify generic variance across the two instantiations.
  controller: supplierController as unknown as IController,
  // Suppliers are company-wide in BigBoss (single-tenant multi-branch model
  // — see AGENTS.md). The Mongoose model has no `organizationId`, so opt
  // out of Arc's default tenant scoping. Without this, CREATE silently
  // drops the injected org and subsequent GETs filter by an absent field
  // → 404 (caught by the Arc HttpTestHarness suite, Batch N).
  tenantField: false,
  schemaOptions: supplierSchemaOptions,
  customSchemas: { ...supplierSchemas, entity: supplierEntitySchema },
  permissions: {
    list: permissions.inventory.supplierView,
    get: permissions.inventory.supplierView,
    create: permissions.inventory.supplierManage,
    update: permissions.inventory.supplierManage,
    delete: permissions.inventory.supplierManage,
  },
});

export default supplierResource;
