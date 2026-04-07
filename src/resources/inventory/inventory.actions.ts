/**
 * Inventory Action Registry
 *
 * Defines Arc action handlers for state transitions on
 * purchases, transfers, and stock requests.
 */
import type { FastifyRequest } from 'fastify';
import type { PermissionCheck } from '@classytic/arc/permissions';
import transferService from './transfer/transfer.service.js';
import stockRequestService from './stock-request/stock-request.service.js';
import { purchaseInvoiceService } from './purchase/index.js';
import permissions from '#config/permissions.js';

interface ActionRequest extends FastifyRequest {
  user: { _id: string; id: string };
}

interface ActionConfig {
  name: string;
  tag: string;
  prefix: string;
  basePath: string;
  actions: Record<string, (id: string, data: Record<string, unknown>, req: ActionRequest) => Promise<unknown>>;
  actionPermissions: Record<string, PermissionCheck>;
  actionSchemas: Record<string, Record<string, { type: string; description?: string; format?: string }>>;
}

export const inventoryActionRegistry: ActionConfig[] = [
  {
    name: 'purchases',
    tag: 'Inventory - Purchases',
    prefix: '/inventory/purchases',
    basePath: '/api/v1/inventory/purchases',
    actions: {
      receive: async (id: string, _data: Record<string, unknown>, req: ActionRequest) =>
        purchaseInvoiceService.receivePurchase(id, req.user._id || req.user.id),
      pay: async (id: string, data: Record<string, unknown>, req: ActionRequest) =>
        purchaseInvoiceService.payPurchase(id, data, req.user._id || req.user.id),
      cancel: async (id: string, data: Record<string, unknown>, req: ActionRequest) =>
        purchaseInvoiceService.cancelPurchase(id, req.user._id || req.user.id, data.reason as string | undefined),
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
      cancel: { reason: { type: 'string', description: 'Cancellation reason' } },
    },
  },
  {
    name: 'transfers',
    tag: 'Inventory - Transfers',
    prefix: '/inventory/transfers',
    basePath: '/api/v1/inventory/transfers',
    actions: {
      approve: async (id: string, _data: Record<string, unknown>, req: ActionRequest) =>
        transferService.approveTransfer(id, req.user._id || req.user.id),
      dispatch: async (id: string, data: Record<string, unknown>, req: ActionRequest) =>
        transferService.dispatchTransfer(
          id,
          (data.transport as Record<string, unknown>) || data,
          req.user._id || req.user.id,
        ),
      'in-transit': async (id: string, _data: Record<string, unknown>, req: ActionRequest) =>
        transferService.markInTransit(id, req.user._id || req.user.id),
      receive: async (id: string, data: Record<string, unknown>, req: ActionRequest) =>
        transferService.receiveTransfer(
          id,
          (data.items as Array<Record<string, unknown>>) || [],
          req.user._id || req.user.id,
        ),
      cancel: async (id: string, data: Record<string, unknown>, req: ActionRequest) =>
        transferService.cancelTransfer(id, data.reason as string | undefined, req.user._id || req.user.id),
    },
    actionPermissions: {
      approve: permissions.inventory.transferApprove,
      dispatch: permissions.inventory.transferDispatch,
      'in-transit': permissions.inventory.transferDispatch,
      receive: permissions.inventory.transferReceive,
      cancel: permissions.inventory.transferCancel,
    },
    actionSchemas: {
      dispatch: { transport: { type: 'object', description: 'Transport details' } },
      receive: { items: { type: 'array', description: 'Received items with quantities' } },
      cancel: { reason: { type: 'string', description: 'Cancellation reason' } },
    },
  },
  {
    name: 'stock-requests',
    tag: 'Inventory - Stock Requests',
    prefix: '/inventory/requests',
    basePath: '/api/v1/inventory/requests',
    actions: {
      approve: async (id: string, data: Record<string, unknown>, req: ActionRequest) =>
        stockRequestService.approveRequest(
          id,
          data.items as Array<Record<string, unknown>> | undefined,
          data.reviewNotes as string | undefined,
          req.user._id || req.user.id,
        ),
      reject: async (id: string, data: Record<string, unknown>, req: ActionRequest) =>
        stockRequestService.rejectRequest(id, data.reason as string | undefined, req.user._id || req.user.id),
      fulfill: async (id: string, data: Record<string, unknown>, req: ActionRequest) =>
        stockRequestService.fulfillRequest(id, data, req.user._id || req.user.id),
      cancel: async (id: string, data: Record<string, unknown>, req: ActionRequest) =>
        stockRequestService.cancelRequest(id, data.reason as string | undefined, req.user._id || req.user.id),
    },
    actionPermissions: {
      approve: permissions.inventory.stockRequestApprove,
      reject: permissions.inventory.stockRequestApprove,
      fulfill: permissions.inventory.stockRequestFulfill,
      cancel: permissions.inventory.stockRequestCancel,
    },
    actionSchemas: {
      approve: { items: { type: 'array' }, reviewNotes: { type: 'string' } },
      reject: { reason: { type: 'string' } },
      fulfill: { items: { type: 'array' } },
      cancel: { reason: { type: 'string' } },
    },
  },
];
