import { createStateMachine } from '@classytic/arc/utils';
import type { createStatusError } from '../shared/status-errors.js';
import { approvePurchase as approvePurchaseAction } from './actions/approve-purchase-order.js';
import { cancelPurchase as cancelPurchaseAction } from './actions/cancel-purchase-order.js';
import { createPurchase as createPurchaseAction } from './actions/create-purchase-order.js';
import { payPurchase as payPurchaseAction } from './actions/pay-purchase-order.js';
import { receivePurchase as receivePurchaseAction } from './actions/receive-purchase-order.js';
import type { CreatePurchaseData, PaymentData, UpdatePurchaseData } from './actions/shared.js';
import { updateDraftPurchase as updateDraftPurchaseAction } from './actions/update-draft-purchase-order.js';
import { PurchaseOrderStatus } from './models/purchase-order.model.js';

const purchaseState = createStateMachine('Purchase', {
  update: [PurchaseOrderStatus.DRAFT],
  approve: [PurchaseOrderStatus.DRAFT],
  receive: [PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.APPROVED],
  cancel: [PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.APPROVED],
  pay: [PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.APPROVED, PurchaseOrderStatus.RECEIVED],
});

const assertPurchaseState = (
  action: string,
  currentState: string,
  errorFactory: typeof createStatusError,
  message: string,
) => {
  purchaseState.assert(action, currentState, errorFactory, message);
};

const purchaseOrderService = {
  createPurchase(data: CreatePurchaseData, actorId: string | undefined) {
    return createPurchaseAction(data, actorId, {
      approvePurchase: this.approvePurchase.bind(this),
      receivePurchase: this.receivePurchase.bind(this),
      payPurchase: this.payPurchase.bind(this),
    });
  },

  updateDraftPurchase(purchaseId: string, data: UpdatePurchaseData, actorId: string | undefined) {
    return updateDraftPurchaseAction(purchaseId, data, actorId, assertPurchaseState);
  },

  approvePurchase(purchaseId: string, actorId: string | undefined) {
    return approvePurchaseAction(purchaseId, actorId, assertPurchaseState);
  },

  receivePurchase(purchaseId: string, actorId: string | undefined) {
    return receivePurchaseAction(purchaseId, actorId, assertPurchaseState);
  },

  cancelPurchase(purchaseId: string, actorId: string | undefined, reason?: string) {
    return cancelPurchaseAction(purchaseId, actorId, reason, assertPurchaseState);
  },

  payPurchase(purchaseId: string, paymentData: PaymentData = {}, actorId: string | undefined) {
    return payPurchaseAction(purchaseId, paymentData, actorId, assertPurchaseState);
  },
};

export default purchaseOrderService;
