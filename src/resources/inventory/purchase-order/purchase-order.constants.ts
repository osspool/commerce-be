/**
 * Purchase-order types + enum-style consts re-exported from `@classytic/purchase`.
 *
 * The package owns the canonical Mongoose model + interfaces. This shim keeps
 * the be-prod call-site idiom (`PurchaseOrderStatus.DRAFT`) working while the
 * underlying string literals come from the package's discriminated unions.
 *
 * Money units note: the package documents amounts as paisa; existing be-prod
 * data + actions still operate in BDT major units. The repository/actions
 * migration to paisa is tracked separately — only the model/type ownership
 * has shifted to the package.
 */

import type {
  IPurchaseOrder,
  IPurchaseOrderItem,
  IStatusHistory,
  PurchaseOrderDocument,
  PurchaseOrderModel,
  PurchaseOrderPaymentStatus as PackagePaymentStatus,
  PurchaseOrderPaymentTerms as PackagePaymentTerms,
  PurchaseOrderStatus as PackageStatus,
} from '@classytic/purchase';

export type {
  IPurchaseOrder,
  IPurchaseOrderItem,
  IStatusHistory,
  PurchaseOrderDocument,
  PurchaseOrderModel,
};

export type PurchaseOrderStatusValue = PackageStatus;
export type PurchaseOrderPaymentStatusValue = PackagePaymentStatus;
export type PurchaseOrderPaymentTermsValue = PackagePaymentTerms;

export const PurchaseOrderStatus = Object.freeze({
  DRAFT: 'draft',
  APPROVED: 'approved',
  RECEIVED: 'received',
  CANCELLED: 'cancelled',
} as const) satisfies Record<string, PurchaseOrderStatusValue>;

export const PurchaseOrderPaymentStatus = Object.freeze({
  UNPAID: 'unpaid',
  PARTIAL: 'partial',
  PAID: 'paid',
} as const) satisfies Record<string, PurchaseOrderPaymentStatusValue>;

export const PurchaseOrderPaymentTerms = Object.freeze({
  CASH: 'cash',
  CREDIT: 'credit',
} as const) satisfies Record<string, PurchaseOrderPaymentTermsValue>;
