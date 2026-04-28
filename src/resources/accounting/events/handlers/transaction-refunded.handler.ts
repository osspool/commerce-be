import config from '#config/index.js';
import { getTransactionModel } from '#shared/revenue/engine.js';
import { type RefundData, refundToPosting } from '../../posting/contracts/refund.contract.js';
import { definePostingHandler } from '../define-posting-handler.js';
import { TransactionRefundedEvent, transactionRefundedSchema } from '../event-definitions.js';

interface TxnDoc {
  _id: { toString(): string };
  amount: number;
  tax?: number;
  method?: string;
  date?: Date;
  branch?: { toString(): string };
  branchCode?: string;
  sourceId?: { toString(): string };
}

export const transactionRefundedHandler = definePostingHandler({
  event: TransactionRefundedEvent,
  payloadSchema: transactionRefundedSchema,

  async build(payload, log) {
    const txn = (await getTransactionModel()
      .findById(payload.transactionId)
      .select('_id amount tax method date source branch branchCode sourceId flow status')
      .lean()) as TxnDoc | null;

    if (!txn) {
      log.warn({ transactionId: payload.transactionId }, 'Refund transaction not found');
      return null;
    }

    if (!txn.branch) {
      log.warn({ transactionId: payload.transactionId }, 'Refund transaction has no branch, skipping');
      return null;
    }

    const data: RefundData = {
      transactionId: txn._id.toString(),
      refundAmount: payload.refundAmount ?? txn.amount,
      tax: txn.tax ?? 0,
      method: txn.method ?? 'unknown',
      date: txn.date ?? new Date(),
      orderId: txn.sourceId?.toString(),
    };

    return {
      branchId: txn.branch.toString(),
      posting: refundToPosting(data, { autoPost: config.accounting.autoPost }),
      logFields: { transactionId: payload.transactionId },
      successMessage: 'Refund reversal journal entry created',
    };
  },
});
