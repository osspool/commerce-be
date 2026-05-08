/**
 * Mushak 6.3 auto-generation bridge.
 *
 * Subscribes to `accounting:order.fulfilled` (the bridged event the COGS
 * handler also listens to) and issues the Mushak 6.3 VAT invoice for the
 * order. Idempotent — if the Musok already exists for this order, the
 * service returns the existing doc and the bridge logs `alreadyExists`.
 *
 * Why bridge style (not `definePostingHandler`):
 *   The posting-handler protocol expects the handler to return
 *   `{ branchId, posting }` so the registry can `createPosting()` for it.
 *   Mushak generation creates a MusokInvoice document, NOT a JE — different
 *   side-effect, different shape. So this is a regular event subscriber that
 *   sits alongside the posting handlers.
 *
 * Failure behaviour:
 *   Mushak generation MUST NOT fail the COGS chain. Errors are logged with
 *   the typed error code so finance can:
 *     - SELLER_BIN_MISSING → set the BIN in Platform Config → VAT
 *     - SRO_REFERENCE_REQUIRED → fix exemption metadata on the order
 *     - ORDER_NOT_FOUND     → investigate event/db sync
 *   The order can be re-tried later via `POST /musok/generate` once the
 *   underlying issue is resolved.
 */

import type { DomainEvent } from '@classytic/primitives/events';
import { subscribe } from '#lib/events/arcEvents.js';
import logger from '#lib/utils/logger.js';
import { OrderFulfilledEvent } from '../event-definitions.js';
import {
  generateMushakFromOrder,
  MushakGenerationError,
} from '#resources/accounting/musok/musok.service.js';

interface OrderFulfilledPayload {
  orderId: string;
  branchId?: string;
}

let registered = false;

export function registerOrderFulfilledMushakBridge(): void {
  if (registered) return;
  registered = true;

  void subscribe(OrderFulfilledEvent.name, async (event: DomainEvent) => {
    const payload = (event.payload ?? {}) as OrderFulfilledPayload;
    if (!payload.orderId) {
      logger.warn({ event }, '[mushak] order-fulfilled bridge: missing orderId');
      return;
    }

    try {
      const result = await generateMushakFromOrder({
        orderId: payload.orderId,
        organizationId: payload.branchId,
      });
      if (result.alreadyExists) {
        logger.debug(
          { orderId: payload.orderId, mushakSerial: result.doc?.mushakSerial },
          '[mushak] auto-generate: invoice already exists',
        );
      } else {
        logger.info(
          {
            orderId: payload.orderId,
            mushakSerial: result.doc?.mushakSerial,
            grandTotal: result.doc?.grandTotal,
          },
          '[mushak] auto-generated 6.3 invoice',
        );
      }
    } catch (err) {
      if (err instanceof MushakGenerationError) {
        logger.warn(
          { orderId: payload.orderId, code: err.code, message: err.message },
          '[mushak] auto-generate skipped — typed error',
        );
      } else {
        logger.error(
          { orderId: payload.orderId, err: err instanceof Error ? err.message : String(err) },
          '[mushak] auto-generate failed unexpectedly',
        );
      }
    }
  });
}
