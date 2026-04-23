/**
 * COD Settlement Posting Contract
 *
 * When the admin records the actual money received from a courier partner
 * (after they deduct their commission, and possibly with a write-off for
 * a short-paid or refused order), we post a second journal entry that
 * clears the A/R receivable posted at placement and books the actual
 * cash/bank receipt + commission expense + any writeoff.
 *
 * Balance invariant, enforced by the endpoint handler before calling this:
 *   actualReceived + courierCommission + writeoff === grossAmount
 *
 * Debit:  1112 Bank (or 1111 Cash) — what the merchant actually received
 * Debit:  6423 Courier COD Commission — what the courier deducted
 * Debit:  6702 Bad Debt Written Off — unrecoverable shortfall (if any)
 * Credit: 1141 Accounts Receivable (partnerId = orderId) — clears the receivable
 *
 * Idempotency key = `cod-settled-${settlementId}` — safe to retry and
 * guarantees each settlement posts exactly one journal entry even under
 * retries from the outbox relay.
 */

import type { PostingInput, PostingItem } from '../posting.service.js';

const AR_TRADE_DEBTORS = '1141';
const BANK_CURRENT = '1112';
const CASH_IN_HAND = '1111';
const COURIER_COD_COMMISSION = '6423';
const BAD_DEBT_WRITTEN_OFF = '6702';

export interface CodSettlementData {
  settlementId: string;
  orderId: string;
  /** paisa — gross expected from the original COD placement (must equal the A/R debit) */
  grossAmount: number;
  /** paisa — what the merchant actually received from the courier */
  actualReceived: number;
  /** paisa — courier's commission / fee deducted from the collection */
  courierCommission: number;
  /** paisa — unrecoverable shortfall (partial collection, refused partial, etc.) */
  writeoff: number;
  /** Destination account for the received money. Defaults to 1112 Bank; use 1111 for cash-in-hand settlements. */
  cashAccount?: '1111' | '1112' | string;
  date: Date;
  notes?: string;
}

export function codSettlementToPosting(
  data: CodSettlementData,
  options: { autoPost?: boolean } = {},
): PostingInput {
  const cashAccount = data.cashAccount || BANK_CURRENT;
  const items: PostingItem[] = [];

  if (data.actualReceived > 0) {
    items.push({
      accountCode: cashAccount,
      debit: data.actualReceived,
      credit: 0,
      label: `COD settlement received — order ${data.orderId}`,
    });
  }

  if (data.courierCommission > 0) {
    items.push({
      accountCode: COURIER_COD_COMMISSION,
      debit: data.courierCommission,
      credit: 0,
      label: 'Courier COD commission',
    });
  }

  if (data.writeoff > 0) {
    items.push({
      accountCode: BAD_DEBT_WRITTEN_OFF,
      debit: data.writeoff,
      credit: 0,
      label: 'COD write-off (short-pay / refused)',
    });
  }

  // Clear the A/R receivable for this order. partnerId matches the
  // placement entry so aging reports net to zero when settled.
  items.push({
    accountCode: AR_TRADE_DEBTORS,
    debit: 0,
    credit: data.grossAmount,
    label: `Clear COD A/R — order ${data.orderId}`,
    partnerId: data.orderId,
    partnerType: 'customer',
  });

  return {
    journalType: 'ECOM_SALES_COD_SETTLEMENT',
    label: data.notes || `COD settlement — order ${data.orderId}`,
    date: data.date,
    items,
    idempotencyKey: `cod-settled-${data.settlementId}`,
    sourceRef: { sourceModel: 'Order', sourceId: data.orderId },
    autoPost: options.autoPost ?? true,
  };
}

/**
 * Validate the settlement inputs add up. The handler MUST call this
 * before emitting the event so we never post an unbalanced journal.
 */
export function validateCodSettlementInputs(data: Pick<CodSettlementData, 'grossAmount' | 'actualReceived' | 'courierCommission' | 'writeoff'>): { ok: true } | { ok: false; reason: string } {
  if (data.grossAmount <= 0) return { ok: false, reason: 'grossAmount must be positive' };
  if (data.actualReceived < 0) return { ok: false, reason: 'actualReceived cannot be negative' };
  if (data.courierCommission < 0) return { ok: false, reason: 'courierCommission cannot be negative' };
  if (data.writeoff < 0) return { ok: false, reason: 'writeoff cannot be negative' };
  const sum = data.actualReceived + data.courierCommission + data.writeoff;
  if (sum !== data.grossAmount) {
    return {
      ok: false,
      reason: `actualReceived + courierCommission + writeoff (${sum}) must equal grossAmount (${data.grossAmount})`,
    };
  }
  return { ok: true };
}

export default { codSettlementToPosting, validateCodSettlementInputs };
