/**
 * Supplier Resource Definition
 */

import type { IController } from '@classytic/arc';
import { createMongooseAdapter, defineResource } from '@classytic/arc';
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
  permissions: {
    list: permissions.inventory.supplierView,
    get: permissions.inventory.supplierView,
    create: permissions.inventory.supplierManage,
    update: permissions.inventory.supplierManage,
    delete: permissions.inventory.supplierManage,
  },
});

export default supplierResource;
