import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';
import Order from './order.model.js';

export const orderSchemaOptions = {
  strictAdditionalProperties: true,
  fieldRules: {
    customer: { systemManaged: true },
    customerName: { systemManaged: true },
    customerPhone: { systemManaged: true },
    customerEmail: { systemManaged: true },
    userId: { systemManaged: true },
    currentPayment: { systemManaged: true },
    timeline: { systemManaged: true },
  },
  query: {
    allowedPopulate: ['customer', 'items.product'],
    filterableFields: {
      customer: { type: 'string' },
      status: { type: 'string' },
      'currentPayment.status': { type: 'string' },
      'currentPayment.method': { type: 'string' },
    },
  },
};

/**
 * Payment Data Schema
 * Customer provides payment details during checkout
 */
export const paymentDataSchema = {
  type: 'object',
  description: 'Payment details for manual verification',
  properties: {
    type: {
      type: 'string',
      description: 'Payment method (cash, bkash, nagad, rocket, bank_transfer, card)',
      examples: ['cash', 'bkash', 'nagad', 'rocket', 'bank_transfer', 'card'],
    },
    gateway: {
      type: 'string',
      description: 'Payment gateway provider (optional, defaults to "manual"). Future: stripe, sslcommerz, bkash_api',
      examples: ['manual', 'stripe', 'sslcommerz'],
      default: 'manual',
    },
    reference: {
      type: 'string',
      minLength: 3,
      maxLength: 100,
      description: 'Payment transaction ID/reference (e.g., bKash TrxID: BGH3K5L90P)',
    },
    senderPhone: {
      type: 'string',
      pattern: '^01[0-9]{9}$',
      description: 'Mobile wallet sender phone number (for bKash, Nagad, Rocket)',
    },
    paymentDetails: {
      type: 'object',
      description: 'Additional payment verification details',
      properties: {
        walletNumber: {
          type: 'string',
          description: 'Mobile wallet account number',
        },
        walletType: {
          type: 'string',
          enum: ['personal', 'merchant'],
          description: 'Wallet account type',
        },
        bankName: {
          type: 'string',
          description: 'Bank name (for bank transfers)',
        },
        accountNumber: {
          type: 'string',
          description: 'Bank account number',
        },
        accountName: {
          type: 'string',
          description: 'Account holder name',
        },
        proofUrl: {
          type: 'string',
          format: 'uri',
          description: 'Payment proof screenshot URL',
        },
      },
    },
    notes: {
      type: 'string',
      maxLength: 500,
      description: 'Additional payment notes from customer',
    },
  },
};

/**
 * Custom Create Order Schema
 * Extends auto-generated schema with paymentData field
 */
export const createOrderSchema = {
  body: {
    type: 'object',
    // Items come from cart server-side; FE only sends delivery/payment/coupon
    required: ['deliveryAddress', 'delivery'],
    properties: {
      idempotencyKey: {
        type: 'string',
        description: 'Optional idempotency key for safely retrying checkout without creating duplicate orders',
        maxLength: 200,
      },
      deliveryAddress: {
        type: 'object',
        // Dev strictness: logistics requires recipient info for delivery labels.
        required: ['addressLine1', 'areaId', 'areaName', 'zoneId', 'city', 'recipientPhone', 'recipientName'],
        properties: {
          label: { type: 'string' },
          recipientName: { type: 'string', minLength: 2, description: 'Recipient name (required for delivery)' },
          recipientPhone: { type: 'string', pattern: '^01[0-9]{9}$', description: 'Recipient phone (for gift orders)' },
          addressLine1: { type: 'string', minLength: 5 },
          addressLine2: { type: 'string' },
          areaId: { type: 'number', description: 'Area.internalId from @classytic/bd-areas' },
          areaName: { type: 'string', minLength: 2, description: 'Area.name (e.g., "Mohammadpur")' },
          zoneId: { type: 'number', minimum: 1, maximum: 6, description: 'Area.zoneId for pricing (1-6)' },
          providerAreaIds: {
            type: 'object',
            description: 'Area.providers - provider-specific area IDs',
            properties: {
              redx: { type: 'number' },
              pathao: { type: 'number' },
              steadfast: { type: 'number' },
            },
          },
          city: { type: 'string', minLength: 2, description: 'Area.districtName' },
          division: { type: 'string', description: 'Area.divisionName' },
          postalCode: { type: 'string' },
          country: { type: 'string', default: 'Bangladesh' },
        },
      },
      delivery: {
        type: 'object',
        required: ['method', 'price'],
        properties: {
          method: { type: 'string', description: 'Delivery method (standard, express)' },
          price: { type: 'number', minimum: 0, description: 'Delivery price in BDT' },
          estimatedDays: { type: 'number', minimum: 0 },
        },
      },
      paymentMethod: {
        type: 'string',
        description: 'Payment method (cash, bkash, nagad, rocket, bank_transfer)',
        default: 'cash',
      },
      paymentData: paymentDataSchema,
      isGift: {
        type: 'boolean',
        default: false,
        description: 'True if ordering on behalf of someone else (use recipientName in deliveryAddress)',
      },
      couponCode: {
        type: 'string',
        description: 'Coupon code to apply',
      },
      branchId: {
        type: 'string',
        description: 'Preferred branch ID for fulfillment (optional). Used for cost price lookup and fulfillment routing. If not specified, default branch is used during fulfillment.',
      },
      branchSlug: {
        type: 'string',
        description: 'Preferred branch slug for fulfillment (alternative to branchId)',
      },
      notes: {
        type: 'string',
        maxLength: 500,
        description: 'Order notes',
      },
    },
  },
};

export const cancelOrderSchema = {
  params: {
    type: 'object',
    properties: {
      id: { type: 'string' },
    },
    required: ['id'],
  },
  body: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Cancellation reason' },
      refund: { type: 'boolean', default: false, description: 'Process refund if payment was verified' },
    },
  },
};

export const cancelRequestSchema = {
  params: {
    type: 'object',
    properties: {
      id: { type: 'string' },
    },
    required: ['id'],
  },
  body: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Reason for cancellation request' },
    },
  },
};

export const updateStatusSchema = {
  params: {
    type: 'object',
    properties: {
      id: { type: 'string' },
    },
    required: ['id'],
  },
  body: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'processing', 'confirmed', 'shipped', 'delivered', 'cancelled'],
        description: 'New order status',
      },
      note: { type: 'string', description: 'Optional note for status change' },
    },
    required: ['status'],
  },
};

export const refundOrderSchema = {
  params: {
    type: 'object',
    properties: {
      id: { type: 'string' },
    },
    required: ['id'],
  },
  body: {
    type: 'object',
    properties: {
      amount: { 
        type: 'number', 
        description: 'Refund amount in smallest unit (paisa). Omit for full refund.' 
      },
      reason: { type: 'string', description: 'Refund reason' },
    },
  },
};

export const fulfillOrderSchema = {
  params: {
    type: 'object',
    properties: {
      id: { type: 'string' },
    },
    required: ['id'],
  },
  body: {
    type: 'object',
    properties: {
      trackingNumber: { type: 'string', description: 'Shipping tracking number' },
      carrier: { type: 'string', description: 'Shipping carrier (e.g., Pathao, Redx)' },
      notes: { type: 'string', description: 'Fulfillment notes' },
      shippedAt: { type: 'string', format: 'date-time', description: 'Shipping date' },
      estimatedDelivery: { type: 'string', format: 'date-time', description: 'Estimated delivery date' },
      branchId: { type: 'string', description: 'Branch ID for inventory decrement (overrides order.branch)' },
      branchSlug: { type: 'string', description: 'Branch slug (alternative to branchId)' },
      recordCogs: {
        type: 'boolean',
        default: false,
        description: 'Record COGS expense transaction. Default: false (profit tracked in order via costPriceAtSale). Set true for explicit double-entry accounting.',
      },
    },
  },
};

const crudSchemas = buildCrudSchemasFromModel(Order, orderSchemaOptions);

export default crudSchemas;
