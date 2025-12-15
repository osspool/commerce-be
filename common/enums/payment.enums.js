/**
 * Payment Enums - Extends @classytic/revenue with Fitverse-specific methods
 *
 * ✅ CORRECT DEPENDENCY DIRECTION: app → lib
 *
 * The revenue library provides base payment types.
 * This module extends with Bangladesh-specific payment methods and gateways.
 *
 * @module common/enums/payment.enums
 */

import {
  PAYMENT_STATUS,
  PAYMENT_STATUS_VALUES,
  PAYMENT_GATEWAY_TYPE as LIBRARY_GATEWAY_TYPES,
  PAYMENT_GATEWAY_TYPE_VALUES as LIBRARY_GATEWAY_VALUES,
} from '@classytic/revenue/enums';

// Re-export library payment status
export {
  PAYMENT_STATUS,
  PAYMENT_STATUS_VALUES,
};

// Extend library gateway types with Bangladesh-specific gateways
export const PAYMENT_GATEWAY_TYPE = {
  ...LIBRARY_GATEWAY_TYPES,     // manual, stripe, sslcommerz
  BKASH_GATEWAY: 'bkash_gateway',
  NAGAD_GATEWAY: 'nagad_gateway',
};

export const PAYMENT_GATEWAY_TYPE_VALUES = Object.values(PAYMENT_GATEWAY_TYPE);

// Fitverse-specific payment methods
export const PAYMENT_METHOD = {
  BKASH: 'bkash',
  NAGAD: 'nagad',
  ROCKET: 'rocket',
  BANK: 'bank',
  CARD: 'card',
  ONLINE: 'online',
  MANUAL: 'manual',
  CASH: 'cash',
};

export const PAYMENT_METHOD_VALUES = Object.values(PAYMENT_METHOD);

export const COMMISSION_STATUS = {
  PENDING: 'pending',
  DUE: 'due',
  PAID: 'paid',
  WAIVED: 'waived',
};

export const COMMISSION_STATUS_VALUES = Object.values(COMMISSION_STATUS);

export default {
  PAYMENT_STATUS,
  PAYMENT_STATUS_VALUES,
  PAYMENT_METHOD,
  PAYMENT_METHOD_VALUES,
  PAYMENT_GATEWAY_TYPE,
  PAYMENT_GATEWAY_TYPE_VALUES,
  COMMISSION_STATUS,
  COMMISSION_STATUS_VALUES,
};
