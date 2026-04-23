import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';
import PurchaseOrder from './models/purchase-order.model.js';

const schemaParts = buildCrudSchemasFromModel(PurchaseOrder, {
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
});

const crudSchemas = ((schemaParts as unknown as Record<string, unknown>).crudSchemas as Record<
  string,
  Record<string, unknown>
>) || {
  create: { body: schemaParts.createBody },
  update: { body: schemaParts.updateBody },
  get: { params: schemaParts.params },
  list: { querystring: schemaParts.listQuery },
  delete: { params: schemaParts.params },
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

export const purchaseEntitySchema = ((schemaParts as unknown as Record<string, unknown>).entitySchema as Record<
  string,
  unknown
>) || {
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
    destinationLocationId: {
      type: 'string',
      description: 'Target Location _id to receive this line into. Defaults to the branch default stock bin.',
    },
  },
  required: ['productId', 'quantity', 'costPrice'],
} as const;

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
} as const;

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
} as const;

export const listPurchasesSchema = crudSchemas.list;
export const getPurchaseSchema = crudSchemas.get;

export default {
  ...crudSchemas,
};
