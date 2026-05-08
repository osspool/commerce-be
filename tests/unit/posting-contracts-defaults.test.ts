/**
 * Posting contract `autoPost` defaults — industry-standard split.
 *
 * Locks down the per-contract intrinsic default and the `options.autoPost`
 * override path. The split mirrors Odoo / ERPNext / Xero:
 *
 *   DRAFT  — documents finance reviews before they hit the books
 *   POSTED — system-driven events (treasury, fulfillment, automation)
 *
 * If a new contract is added under `posting/contracts/`, add it here too.
 * One assertion per function, plus a single override-sanity block.
 */

import { describe, it, expect } from 'vitest';

// Document contracts (DRAFT)
import { customerInvoiceToPosting } from '#resources/accounting/posting/contracts/customer-invoice.contract.js';
import {
  vendorBillToPosting,
  vendorBillReversalToPosting,
  supplierReturnToPosting,
} from '#resources/accounting/posting/contracts/vendor-bill.contract.js';
import { openingBalanceToPosting } from '#resources/accounting/posting/contracts/opening-balance.contract.js';
import {
  vendorCreditNoteToPosting,
  customerDebitNoteToPosting,
} from '#resources/accounting/posting/contracts/credit-debit-note.contract.js';
import { stockAdjustmentToPosting } from '#resources/accounting/posting/contracts/inventory.contract.js';
import { importClearanceToPosting } from '#resources/accounting/posting/contracts/import-clearance.contract.js';
import { purchaseToPosting } from '#resources/accounting/posting/contracts/purchase.contract.js';

// Automation contracts (POSTED)
import { customerReceiptToPosting } from '#resources/accounting/posting/contracts/customer-invoice.contract.js';
import { vendorPaymentToPosting } from '#resources/accounting/posting/contracts/vendor-bill.contract.js';
import {
  salesTransactionToPosting,
  dailyPosSummaryToPosting,
} from '#resources/accounting/posting/contracts/sales.contract.js';
import {
  cogsToPosting,
  cogsReversalToPosting,
} from '#resources/accounting/posting/contracts/inventory.contract.js';
import { codPlacementToPosting } from '#resources/accounting/posting/contracts/cod-placement.contract.js';
import { codSettlementToPosting } from '#resources/accounting/posting/contracts/cod-settlement.contract.js';
import { codCancellationToPosting } from '#resources/accounting/posting/contracts/cod-cancellation.contract.js';
import { refundToPosting } from '#resources/accounting/posting/contracts/refund.contract.js';
import { restockingFeeToPosting } from '#resources/accounting/posting/contracts/restocking-fee.contract.js';
import {
  transferDispatchToPosting,
  transferReceiveToPosting,
  transferDispatchReversalToPosting,
  transferReceiveReversalToPosting,
} from '#resources/accounting/posting/contracts/transfer.contract.js';

const DATE = new Date('2026-04-15T12:00:00Z');

describe('posting contract autoPost defaults', () => {
  describe('DRAFT — documents (accountant must review before posting)', () => {
    it('customerInvoiceToPosting → false', () => {
      expect(
        customerInvoiceToPosting({
          orderId: 'ord-1',
          customerId: 'cust-1',
          totalAmount: 10000,
          issuedAt: DATE,
        }).autoPost,
      ).toBe(false);
    });

    it('vendorBillToPosting → false', () => {
      expect(
        vendorBillToPosting({
          purchaseId: 'po-1',
          supplierId: 'sup-1',
          totalAmount: 50000,
          receivedAt: DATE,
        }).autoPost,
      ).toBe(false);
    });

    it('vendorBillReversalToPosting → false', () => {
      expect(
        vendorBillReversalToPosting({
          purchaseId: 'po-1',
          supplierId: 'sup-1',
          totalAmount: 50000,
        }).autoPost,
      ).toBe(false);
    });

    it('supplierReturnToPosting → false', () => {
      expect(
        supplierReturnToPosting({
          purchaseId: 'po-1',
          supplierId: 'sup-1',
          moveGroupId: 'mg-1',
          lines: [{ skuRef: 'sku-1', quantityReturned: 1, unitCost: 10 }],
        }).autoPost,
      ).toBe(false);
    });

    it('openingBalanceToPosting → false', () => {
      expect(
        openingBalanceToPosting({
          side: 'customer',
          partnerId: 'cust-1',
          amount: 10000,
        }).autoPost,
      ).toBe(false);
    });

    it('vendorCreditNoteToPosting → false', () => {
      expect(
        vendorCreditNoteToPosting({
          sourceId: 'po-1',
          sourceModel: 'PurchaseOrder',
          amount: 1000,
          reason: 'Damaged goods returned',
          reference: 'CN-001',
          supplierId: 'sup-1',
        }).autoPost,
      ).toBe(false);
    });

    it('customerDebitNoteToPosting → false', () => {
      expect(
        customerDebitNoteToPosting({
          sourceId: 'ord-1',
          sourceModel: 'Order',
          amount: 1000,
          reason: 'Customer return allowance',
          reference: 'DN-001',
          customerId: 'cust-1',
        }).autoPost,
      ).toBe(false);
    });

    it('stockAdjustmentToPosting → false', () => {
      expect(
        stockAdjustmentToPosting({
          adjustmentId: 'adj-1',
          type: 'loss',
          amount: 500,
          date: DATE,
        }).autoPost,
      ).toBe(false);
    });

    it('importClearanceToPosting → false', () => {
      expect(
        importClearanceToPosting({
          clearanceId: 'imp-1',
          supplierId: 'sup-foreign',
          assessableValue: 100000,
          cdRate: 25,
          date: DATE,
        }).autoPost,
      ).toBe(false);
    });

    it('purchaseToPosting → false', () => {
      expect(
        purchaseToPosting({
          purchaseId: 'po-1',
          supplierId: 'sup-1',
          totalAmount: 50000,
          tax: 0,
          date: DATE,
        }).autoPost,
      ).toBe(false);
    });
  });

  describe('POSTED — automation (system-driven, no human in loop)', () => {
    it('salesTransactionToPosting → true', () => {
      expect(
        salesTransactionToPosting({
          transactionId: 'tx-1',
          amount: 10000,
          tax: 1500,
          method: 'card',
          date: DATE,
        }).autoPost,
      ).toBe(true);
    });

    it('dailyPosSummaryToPosting → true', () => {
      expect(
        dailyPosSummaryToPosting({
          branchId: 'b-1',
          branchCode: 'BR1',
          date: '2026-04-15',
          byMethod: [{ method: 'cash', amount: 10000 }],
          totalAmount: 10000,
          totalTax: 0,
          transactionCount: 1,
        }).autoPost,
      ).toBe(true);
    });

    it('customerReceiptToPosting → true', () => {
      expect(
        customerReceiptToPosting({
          orderId: 'ord-1',
          customerId: 'cust-1',
          amount: 10000,
          date: DATE,
        }).autoPost,
      ).toBe(true);
    });

    it('vendorPaymentToPosting → true', () => {
      expect(
        vendorPaymentToPosting({
          purchaseId: 'po-1',
          supplierId: 'sup-1',
          amount: 50000,
          date: DATE,
        }).autoPost,
      ).toBe(true);
    });

    it('cogsToPosting → true', () => {
      expect(
        cogsToPosting({
          orderId: 'ord-1',
          costAmount: 6000,
          date: DATE,
        }).autoPost,
      ).toBe(true);
    });

    it('cogsReversalToPosting → true', () => {
      expect(
        cogsReversalToPosting({
          returnId: 'ret-1',
          orderId: 'ord-1',
          costAmount: 6000,
          date: DATE,
        }).autoPost,
      ).toBe(true);
    });

    it('codPlacementToPosting → true', () => {
      expect(
        codPlacementToPosting({
          transactionId: 'tx-1',
          orderId: 'ord-1',
          amount: 10000,
          tax: 1500,
          date: DATE,
        }).autoPost,
      ).toBe(true);
    });

    it('codSettlementToPosting → true', () => {
      expect(
        codSettlementToPosting({
          settlementId: 'set-1',
          orderId: 'ord-1',
          grossAmount: 10000,
          actualReceived: 9000,
          courierCommission: 1000,
          writeoff: 0,
          date: DATE,
        }).autoPost,
      ).toBe(true);
    });

    it('codCancellationToPosting → true', () => {
      expect(
        codCancellationToPosting({
          orderId: 'ord-1',
          grossAmount: 10000,
          tax: 1500,
          date: DATE,
        }).autoPost,
      ).toBe(true);
    });

    it('refundToPosting → true', () => {
      expect(
        refundToPosting({
          transactionId: 'tx-1',
          refundAmount: 10000,
          tax: 1500,
          method: 'card',
          date: DATE,
        }).autoPost,
      ).toBe(true);
    });

    it('restockingFeeToPosting → true', () => {
      expect(
        restockingFeeToPosting({
          changeNumber: 'CHG-1',
          orderId: 'ord-1',
          amount: 500,
          date: DATE,
        }).autoPost,
      ).toBe(true);
    });

    it('transferDispatchToPosting → true', () => {
      expect(
        transferDispatchToPosting({
          transferId: 'tr-1',
          documentNumber: 'TRF-001',
          goodsCost: 10000,
          date: DATE,
        }).autoPost,
      ).toBe(true);
    });

    it('transferReceiveToPosting → true', () => {
      expect(
        transferReceiveToPosting({
          transferId: 'tr-1',
          documentNumber: 'TRF-001',
          goodsCost: 10000,
          date: DATE,
        }).autoPost,
      ).toBe(true);
    });

    it('transferDispatchReversalToPosting → true', () => {
      expect(
        transferDispatchReversalToPosting({
          transferId: 'tr-1',
          documentNumber: 'TRF-001',
          goodsCost: 10000,
          date: DATE,
        }).autoPost,
      ).toBe(true);
    });

    it('transferReceiveReversalToPosting → true', () => {
      expect(
        transferReceiveReversalToPosting({
          transferId: 'tr-1',
          documentNumber: 'TRF-001',
          goodsCost: 10000,
          date: DATE,
        }).autoPost,
      ).toBe(true);
    });
  });

  describe('options.autoPost overrides intrinsic default', () => {
    it('vendorBillToPosting can be forced to post via { autoPost: true }', () => {
      expect(
        vendorBillToPosting(
          { purchaseId: 'po-1', supplierId: 'sup-1', totalAmount: 50000, receivedAt: DATE },
          { autoPost: true },
        ).autoPost,
      ).toBe(true);
    });

    it('salesTransactionToPosting can be forced to draft via { autoPost: false }', () => {
      expect(
        salesTransactionToPosting(
          { transactionId: 'tx-1', amount: 10000, tax: 1500, method: 'card', date: DATE },
          { autoPost: false },
        ).autoPost,
      ).toBe(false);
    });
  });

  // Locks the per-instrument account-routing decisions (Stripe / bKash /
  // courier each settle on their own timeline; routing them to the right
  // clearing account is the prerequisite for any settlement-reconciliation
  // report ever working). Asserts the cash-side debit account on the JE,
  // not just `autoPost`. If a renumber happens in ledger-bd, these flip
  // before any production data hits the wrong line.
  describe('payment-method routing — clearing-account semantics', () => {
    function debitAccountCodeFor(method: string): string | undefined {
      const posting = salesTransactionToPosting({
        transactionId: 'tx-1',
        amount: 10000,
        tax: 0,
        method,
        date: DATE,
      });
      return posting.items.find((i) => i.debit > 0)?.accountCode;
    }

    it('cash → 1111 Petty Cash (drawer, immediate)', () => {
      expect(debitAccountCodeFor('cash')).toBe('1111');
    });

    it('card → 1125 Gateway Clearing (Stripe / SSLCommerz hold, 1-3d settlement)', () => {
      expect(debitAccountCodeFor('card')).toBe('1125');
    });

    it('bkash / nagad / rocket → 1126 Mobile Money Merchant Clearing', () => {
      expect(debitAccountCodeFor('bkash')).toBe('1126');
      expect(debitAccountCodeFor('nagad')).toBe('1126');
      expect(debitAccountCodeFor('rocket')).toBe('1126');
    });

    it('bank_transfer → 1113 Cash at Bank (direct deposit)', () => {
      expect(debitAccountCodeFor('bank_transfer')).toBe('1113');
    });
  });
});
