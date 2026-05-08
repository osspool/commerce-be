/**
 * The complete set of accounting event subscribers.
 *
 * Adding a new posting handler is a one-line entry here plus a single
 * file under `./handlers/`. Removing one is a one-line delete. The
 * order does not matter — every entry is an independent subscriber.
 *
 * **Posting strategy across these handlers:**
 *
 *   SOURCE            EVENT                          JOURNAL TYPE         TIMING
 *   ─────────────────────────────────────────────────────────────────────────────
 *   Online order      accounting:order.paid          ECOM_SALES / A/R     immediate
 *   Online refund     accounting:transaction.refunded ECOM_SALES rev.     immediate
 *   COGS              accounting:order.fulfilled     INVENTORY            immediate
 *   COGS reversal     accounting:return.restocked    INVENTORY            immediate
 *   Inventory adj.    accounting:inventory.adjusted  INVENTORY            immediate
 *   Purchase paid     accounting:purchase.paid       PURCHASES            immediate
 *   Vendor bill       purchase:received              A/P (accrual)        on receipt
 *   COD settlement    accounting:cod.settled         A/R clear → Bank+Comm immediate
 *   COD cancellation  accounting:cod.cancelled       A/R reversal         immediate
 *
 * **Not in this list — by design:**
 *   - POS sales: posted via `@classytic/pos` `LedgerBridge` at shift
 *     close, not per-transaction. The legacy `accounting:day.auto-close`
 *     was deleted along with `daily-sales.service.ts`.
 *   - `order:fulfilled` (FSM event from the order package): bridged to
 *     `accounting:order.fulfilled` by
 *     `resources/sales/orders/lifecycle/handlers/ledger-cogs-bridge.ts`
 *     because the order FSM only carries `orderNumber`, not `orderId`.
 *     The COGS subscriber here listens on the bridged event.
 */

import type { PostingHandler } from './define-posting-handler.js';
import { codCancelledHandler } from './handlers/cod-cancelled.handler.js';
import { codSettledHandler } from './handlers/cod-settled.handler.js';
import { inventoryAdjustedHandler } from './handlers/inventory-adjusted.handler.js';
import { orderFulfilledHandler } from './handlers/order-fulfilled.handler.js';
import { orderPaidHandler } from './handlers/order-paid.handler.js';
import { purchasePaidHandler } from './handlers/purchase-paid.handler.js';
import { purchaseReceivedHandler } from './handlers/purchase-received.handler.js';
import { returnRestockedHandler } from './handlers/return-restocked.handler.js';
import { rmaRestockingFeeCollectedHandler } from './handlers/rma-restocking-fee.handler.js';
import { transactionRefundedHandler } from './handlers/transaction-refunded.handler.js';

export const postingHandlers: ReadonlyArray<PostingHandler<unknown>> = [
  orderPaidHandler,
  transactionRefundedHandler,
  orderFulfilledHandler,
  returnRestockedHandler,
  inventoryAdjustedHandler,
  rmaRestockingFeeCollectedHandler,
  purchasePaidHandler,
  purchaseReceivedHandler,
  codSettledHandler,
  codCancelledHandler,
] as ReadonlyArray<PostingHandler<unknown>>;
