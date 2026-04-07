/**
 * Supplier Resource Definition
 */
import { defineResource } from '@classytic/arc';
import type { IController } from '@classytic/arc';
import { createAdapter } from '#shared/adapter.js';
import permissions from '#config/permissions.js';
import {
  Supplier,
  supplierController,
  supplierRepository,
  supplierSchemas,
  supplierEntitySchema,
  supplierSchemaOptions,
} from './index.js';

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
