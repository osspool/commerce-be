/**
 * Map be-prod's gateway / payment-method strings to the universal
 * `PaymentMethodKind` category that `@classytic/revenue`, `@classytic/order`,
 * and `@classytic/invoice` now require on payment inputs.
 *
 * `methodKind` is the coarse category (card / mobile_money / cash / …); the
 * original gateway string is preserved separately as the method *code*. Keep
 * this table in sync with the gateway strings the FE `PaymentMethods` and the
 * place-order / POS handlers emit. Unknown gateways fall through to `other`
 * (the documented last-resort value), never throw.
 */
import { PAYMENT_METHOD_KIND, type PaymentMethodKind } from '@classytic/primitives/payment-method-kind';

const GATEWAY_TO_KIND: Record<string, PaymentMethodKind> = {
  // Cards / card aggregators
  card: PAYMENT_METHOD_KIND.CARD,
  stripe: PAYMENT_METHOD_KIND.CARD,
  // Bank rails
  bank_transfer: PAYMENT_METHOD_KIND.BANK_TRANSFER,
  bank: PAYMENT_METHOD_KIND.BANK_TRANSFER,
  // Mobile financial services (Bangladesh MFS + global mobile money)
  bkash: PAYMENT_METHOD_KIND.MOBILE_MONEY,
  nagad: PAYMENT_METHOD_KIND.MOBILE_MONEY,
  rocket: PAYMENT_METHOD_KIND.MOBILE_MONEY,
  upay: PAYMENT_METHOD_KIND.MOBILE_MONEY,
  mobile_money: PAYMENT_METHOD_KIND.MOBILE_MONEY,
  // Digital wallets
  wallet: PAYMENT_METHOD_KIND.WALLET,
  // Cash-equivalent
  cash: PAYMENT_METHOD_KIND.CASH,
  cod: PAYMENT_METHOD_KIND.CASH,
  pos: PAYMENT_METHOD_KIND.CASH,
  cheque: PAYMENT_METHOD_KIND.CHEQUE,
  // Operator-recorded settlement
  manual: PAYMENT_METHOD_KIND.MANUAL,
  // Multi-instrument redirect aggregator — actual instrument is resolved at
  // the gateway, unknown to us at intent time.
  sslcommerz: PAYMENT_METHOD_KIND.OTHER,
};

/** Resolve a gateway / method string to its `PaymentMethodKind`. */
export function resolveMethodKind(value: string | undefined | null): PaymentMethodKind {
  if (!value) return PAYMENT_METHOD_KIND.OTHER;
  return GATEWAY_TO_KIND[value.toLowerCase()] ?? PAYMENT_METHOD_KIND.OTHER;
}
