import transferService from './transfer/transfer.service.js';
import stockRequestService from './stock-request/stock-request.service.js';
import { purchaseInvoiceService } from './purchase/index.js';
import permissions from '#config/permissions.js';

export const inventoryActionRegistry = [
  {
    name: 'purchases',
    tag: 'Inventory - Purchases',
    prefix: '/inventory/purchases',
    basePath: '/api/v1/inventory/purchases',
    actions: {
      receive: async (id, _data, req) => {
        return purchaseInvoiceService.receivePurchase(id, req.user._id || req.user.id);
      },
      pay: async (id, data, req) => {
        return purchaseInvoiceService.payPurchase(id, data, req.user._id || req.user.id);
      },
      cancel: async (id, data, req) => {
        return purchaseInvoiceService.cancelPurchase(id, req.user._id || req.user.id, data.reason);
      },
    },
    actionPermissions: {
      receive: permissions.inventory.purchaseReceive,
      pay: permissions.inventory.purchasePay,
      cancel: permissions.inventory.purchaseCancel,
    },
    actionSchemas: {
      pay: {
        amount: { type: 'number', description: 'Payment amount (BDT)' },
        method: { type: 'string', description: 'Payment method' },
        reference: { type: 'string', description: 'Payment reference' },
        accountNumber: { type: 'string' },
        walletNumber: { type: 'string' },
        bankName: { type: 'string' },
        accountName: { type: 'string' },
        proofUrl: { type: 'string' },
        transactionDate: { type: 'string', format: 'date-time' },
        notes: { type: 'string' },
      },
      cancel: {
        reason: { type: 'string', description: 'Cancellation reason' },
      },
    },
  },
  {
    name: 'transfers',
    tag: 'Inventory - Transfers',
    prefix: '/inventory/transfers',
    basePath: '/api/v1/inventory/transfers',
    actions: {
      approve: async (id, _data, req) => {
        return transferService.approveTransfer(id, req.user._id || req.user.id);
      },
      dispatch: async (id, data, req) => {
        return transferService.dispatchTransfer(id, data.transport || data, req.user._id || req.user.id);
      },
      'in-transit': async (id, _data, req) => {
        return transferService.markInTransit(id, req.user._id || req.user.id);
      },
      receive: async (id, data, req) => {
        return transferService.receiveTransfer(id, data.items || [], req.user._id || req.user.id);
      },
      cancel: async (id, data, req) => {
        return transferService.cancelTransfer(id, data.reason, req.user._id || req.user.id);
      },
    },
    actionPermissions: {
      approve: permissions.inventory.transferApprove,
      dispatch: permissions.inventory.transferDispatch,
      'in-transit': permissions.inventory.transferDispatch,
      receive: permissions.inventory.transferReceive,
      cancel: permissions.inventory.transferCancel,
    },
    actionSchemas: {
      dispatch: {
        transport: {
          type: 'object',
          description: 'Transport details (vehicle, driver, etc.)',
          properties: {
            vehicleNumber: { type: 'string' },
            driverName: { type: 'string' },
            driverPhone: { type: 'string' },
            notes: { type: 'string' },
          },
        },
      },
      receive: {
        items: {
          type: 'array',
          description: 'Received items with quantities',
          items: {
            type: 'object',
            properties: {
              itemId: { type: 'string' },
              productId: { type: 'string' },
              variantSku: { type: 'string' },
              quantityReceived: { type: 'number' },
            },
          },
        },
      },
      cancel: {
        reason: { type: 'string', description: 'Cancellation reason' },
      },
    },
  },
  {
    name: 'requests',
    tag: 'Inventory - Stock Requests',
    prefix: '/inventory/requests',
    basePath: '/api/v1/inventory/requests',
    actions: {
      approve: async (id, data, req) => {
        return stockRequestService.approveRequest(
          id,
          data.items || data.approvedItems,
          data.reviewNotes || data.notes,
          req.user._id || req.user.id
        );
      },
      reject: async (id, data, req) => {
        return stockRequestService.rejectRequest(id, data.reason, req.user._id || req.user.id);
      },
      fulfill: async (id, data, req) => {
        return stockRequestService.fulfillRequest(id, data, req.user._id || req.user.id);
      },
      cancel: async (id, data, req) => {
        return stockRequestService.cancelRequest(id, data.reason, req.user._id || req.user.id);
      },
    },
    actionPermissions: {
      approve: permissions.inventory.stockRequestApprove,
      reject: permissions.inventory.stockRequestApprove,
      fulfill: permissions.inventory.stockRequestFulfill,
      cancel: permissions.inventory.stockRequestCancel,
    },
    actionSchemas: {
      approve: {
        items: {
          type: 'array',
          description: 'Items with approved quantities',
          items: {
            type: 'object',
            properties: {
              itemId: { type: 'string' },
              productId: { type: 'string' },
              variantSku: { type: 'string' },
              quantityApproved: { type: 'number' },
            },
          },
        },
        reviewNotes: { type: 'string', description: 'Review notes' },
      },
      reject: {
        reason: { type: 'string', description: 'Rejection reason' },
      },
      cancel: {
        reason: { type: 'string', description: 'Cancellation reason' },
      },
    },
  },
];
