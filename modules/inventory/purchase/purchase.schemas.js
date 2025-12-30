import Purchase from './models/purchase.model.js';
import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';

const schemaParts = buildCrudSchemasFromModel(Purchase, {
  strictAdditionalProperties: true,
  fieldRules: {
    invoiceNumber: { systemManaged: true },
    branch: { systemManaged: true },
    status: { systemManaged: true },
    paymentStatus: { systemManaged: true },
    paidAmount: { systemManaged: true },
    dueAmount: { systemManaged: true },
    subTotal: { systemManaged: true },
    discountTotal: { systemManaged: true },
    taxTotal: { systemManaged: true },
    grandTotal: { systemManaged: true },
    transactionIds: { systemManaged: true },
    statusHistory: { systemManaged: true },
    approvedBy: { systemManaged: true },
    approvedAt: { systemManaged: true },
    receivedBy: { systemManaged: true },
    receivedAt: { systemManaged: true },
    createdBy: { systemManaged: true },
    updatedBy: { systemManaged: true },
  },
  query: {
    filterableFields: {
      supplier: 'ObjectId',
      branch: 'ObjectId',
      status: 'string',
      paymentStatus: 'string',
      invoiceNumber: 'string',
      purchaseOrderNumber: 'string',
      createdAt: 'date',
    },
  },
});

const crudSchemas = schemaParts.crudSchemas || {
  create: { body: schemaParts.createBody },
  update: { body: schemaParts.updateBody },
  get: { params: schemaParts.params },
  list: { querystring: schemaParts.listQuery },
  remove: { params: schemaParts.params },
};

export const purchaseSchemaOptions = {
  query: {
    allowedPopulate: ['supplier', 'branch'],
    filterableFields: {
      supplier: 'ObjectId',
      branch: 'ObjectId',
      status: 'string',
      paymentStatus: 'string',
      invoiceNumber: 'string',
      purchaseOrderNumber: 'string',
      createdAt: 'date',
    },
  },
};

export const purchaseEntitySchema = schemaParts.entitySchema || {
  type: 'object',
  additionalProperties: true,
};

const purchaseItemInputSchema = {
  type: 'object',
  properties: {
    productId: { type: 'string' },
    variantSku: { type: 'string', nullable: true },
    quantity: { type: 'number', minimum: 0 },
    costPrice: { type: 'number', minimum: 0 },
    discount: { type: 'number', minimum: 0 },
    taxRate: { type: 'number', minimum: 0, maximum: 100 },
    notes: { type: 'string' },
  },
  required: ['productId', 'quantity', 'costPrice'],
};

export const createPurchaseSchema = {
  body: {
    type: 'object',
    properties: {
      supplierId: { type: 'string' },
      branchId: { type: 'string' },
      purchaseOrderNumber: { type: 'string' },
      invoiceDate: { type: 'string', format: 'date-time' },
      paymentTerms: { type: 'string', enum: ['cash', 'credit'] },
      creditDays: { type: 'number', minimum: 0 },
      dueDate: { type: 'string', format: 'date-time' },
      notes: { type: 'string' },
      items: {
        type: 'array',
        minItems: 1,
        items: purchaseItemInputSchema,
      },
      autoApprove: { type: 'boolean', default: false },
      autoReceive: { type: 'boolean', default: false },
      payment: {
        type: 'object',
        properties: {
          amount: { type: 'number', minimum: 0 },
          method: { type: 'string', enum: ['cash', 'bkash', 'nagad', 'rocket', 'bank_transfer', 'card'] },
          reference: { type: 'string' },
          accountNumber: { type: 'string' },
          walletNumber: { type: 'string' },
          bankName: { type: 'string' },
          accountName: { type: 'string' },
          proofUrl: { type: 'string' },
          transactionDate: { type: 'string', format: 'date-time' },
          notes: { type: 'string' },
        },
      },
    },
    required: ['items'],
  },
};

export const updatePurchaseSchema = {
  body: {
    type: 'object',
    properties: {
      supplierId: { type: 'string' },
      purchaseOrderNumber: { type: 'string' },
      invoiceDate: { type: 'string', format: 'date-time' },
      paymentTerms: { type: 'string', enum: ['cash', 'credit'] },
      creditDays: { type: 'number', minimum: 0 },
      dueDate: { type: 'string', format: 'date-time' },
      notes: { type: 'string' },
      items: {
        type: 'array',
        minItems: 1,
        items: purchaseItemInputSchema,
      },
    },
  },
};

export const listPurchasesSchema = crudSchemas.list;
export const getPurchaseSchema = crudSchemas.get;

export default {
  ...crudSchemas,
};
