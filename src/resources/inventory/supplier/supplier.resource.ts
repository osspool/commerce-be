/**
 * Supplier Resource Definition
 */

import type { IController } from '@classytic/arc';
import { defineResource } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import permissions from '#config/permissions.js';
import Supplier from './models/supplier.model.js';
import supplierController from './supplier.controller.js';
import supplierRepository from './supplier.repository.js';
import supplierSchemas, { supplierEntitySchema } from './supplier.schemas.js';

const supplierResource = defineResource({
  name: 'supplier',
  audit: true,
  displayName: 'Suppliers',
  tag: 'Inventory - Suppliers',
  prefix: '/inventory/suppliers',
  adapter: createMongooseAdapter(Supplier, supplierRepository),
  // BaseController<AnyRecord> is structurally compatible with IController but
  // TypeScript cannot verify generic variance across the two instantiations.
  controller: supplierController as unknown as IController,
  customSchemas: { ...supplierSchemas, entity: supplierEntitySchema },
  // Suppliers are company-wide (no organizationId field on the model).
  // Declaring tenantField: false here prevents Arc from emitting a
  // "dropped resource-level tenantField" warning when the custom controller
  // is used (the controller already sets tenantField: false on its super() call).
  tenantField: false,
  permissions: {
    list: permissions.inventory.supplierView,
    get: permissions.inventory.supplierView,
    create: permissions.inventory.supplierManage,
    update: permissions.inventory.supplierManage,
    delete: permissions.inventory.supplierManage,
  },
});

export default supplierResource;
