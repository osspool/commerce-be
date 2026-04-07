/**
 * Stock Validation & Reservation Service — Flow-powered
 *
 * - validate: checks Flow StockQuant availability
 * - reserve/commit/release: uses Flow's ReservationService
 * - decrement/restore: delegates to stockTransactionService (Flow MoveGroups)
 * - cleanup: uses Flow's cleanupExpired
 */

import crypto from 'node:crypto';
import type { FlowContext } from '@classytic/flow';
import {
  stockTransactionService,
  getFlowEngine,
  getFlowEngineOrNull,
  buildFlowContext,
  skuRefFromProduct,
  DEFAULT_LOCATION,
} from '#resources/inventory/index.js';
import branchRepository from '../../branch/branch.repository.js';
import logger from '#lib/utils/logger.js';

const RESERVATION_TTL_MINUTES = 15;

interface StockItem {
  productId: string;
  variantSku?: string | null;
  quantity: number;
  productName?: string;
}

interface NormalizedItem {
  productId: string;
  variantSku: string | null;
  quantity: number;
  productName?: string;
}

interface UnavailableItem {
  productId: string;
  productName?: string;
  variantSku?: string | null;
  requested: number;
  available: number;
  reserved: number;
  shortage: number;
}

interface ValidationResult {
  valid: boolean;
  unavailable: UnavailableItem[];
}

interface ValidateOptions {
  throwOnFailure?: boolean;
}

interface ReserveResult {
  success: boolean;
  reservationId: string;
  expiresAt: Date;
  flowReservationIds: string[];
}

interface CommitResult {
  success: boolean;
  decrementedItems: unknown[];
}

interface DecrementOptions {
  skipValidation?: boolean;
}

interface AuditReference {
  model: string;
  id?: string;
}

export class StockValidationError extends Error {
  statusCode: number;
  code: string;
  unavailableItems: UnavailableItem[];

  constructor(unavailableItems: UnavailableItem[]) {
    const message = unavailableItems
      .map((i) => `${i.productName || i.productId}: need ${i.requested}, have ${i.available}`)
      .join('; ');
    super(`Insufficient stock: ${message}`);
    this.name = 'StockValidationError';
    this.statusCode = 400;
    this.code = 'INSUFFICIENT_STOCK';
    this.unavailableItems = unavailableItems;
  }
}

class StockReservationError extends Error {
  statusCode: number;
  code: string;
  reservationId: string | null;

  constructor(message: string, reservationId: string | null) {
    super(message);
    this.name = 'StockReservationError';
    this.statusCode = 409;
    this.code = 'RESERVATION_ERROR';
    this.reservationId = reservationId;
  }
}

class StockService {
  private _normalizeItems(items: StockItem[]): NormalizedItem[] {
    return (items || [])
      .filter(Boolean)
      .map((i) => ({
        productId: i.productId?.toString?.() || String(i.productId),
        variantSku: i.variantSku || null,
        quantity: Number(i.quantity),
        productName: i.productName,
      }))
      .filter((i) => i.productId && Number.isFinite(i.quantity) && i.quantity > 0);
  }

  // ===========================================================================
  // Stock Validation (via Flow)
  // ===========================================================================

  async validate(items: StockItem[], branchId?: string, options: ValidateOptions = {}): Promise<ValidationResult> {
    const { throwOnFailure = true } = options;
    if (!items?.length) return { valid: true, unavailable: [] };

    const branch = branchId || String((await branchRepository.getDefaultBranch())._id);
    const normalized = this._normalizeItems(items);
    const flow = getFlowEngine();
    const ctx = buildFlowContext(String(branch));

    const unavailable: UnavailableItem[] = [];

    for (const item of normalized) {
      const skuRef = skuRefFromProduct(item.productId, item.variantSku);
      const avail = await flow.services.quant.getAvailability({ skuRef, locationId: DEFAULT_LOCATION }, ctx);

      if (avail.quantityAvailable < item.quantity) {
        unavailable.push({
          productId: item.productId,
          productName: item.productName,
          variantSku: item.variantSku,
          requested: item.quantity,
          available: Math.max(0, avail.quantityAvailable),
          reserved: avail.quantityReserved,
          shortage: item.quantity - avail.quantityAvailable,
        });
      }
    }

    const result: ValidationResult = { valid: unavailable.length === 0, unavailable };
    if (!result.valid && throwOnFailure) throw new StockValidationError(unavailable);
    return result;
  }

  async isAvailable(
    productId: string,
    variantSku: string | null,
    quantity: number,
    branchId?: string,
  ): Promise<boolean> {
    const result = await this.validate([{ productId, variantSku, quantity }], branchId, { throwOnFailure: false });
    return result.valid;
  }

  // ===========================================================================
  // Stock Reservation (via Flow ReservationService)
  // ===========================================================================

  async reserve(
    reservationId: string | null,
    items: StockItem[],
    branchId?: string,
    ttlMinutes: number = RESERVATION_TTL_MINUTES,
  ): Promise<ReserveResult> {
    const effectiveId = reservationId || crypto.randomUUID();
    const branch = branchId || String((await branchRepository.getDefaultBranch())._id);
    const normalized = this._normalizeItems(items);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    if (!normalized.length) throw new StockReservationError('No items to reserve', effectiveId);

    const flow = getFlowEngine();
    const ctx = { ...buildFlowContext(String(branch)), idempotencyKey: effectiveId };

    const flowReservations: Array<{ _id: string }> = [];
    try {
      for (const item of normalized) {
        const skuRef = skuRefFromProduct(item.productId, item.variantSku);
        const reservation = await flow.services.reservation.reserve(
          {
            reservationType: 'hard',
            ownerType: 'cart',
            ownerId: effectiveId,
            skuRef,
            locationId: DEFAULT_LOCATION,
            quantity: item.quantity,
            expiresAt,
          },
          ctx,
        );
        flowReservations.push(reservation);
      }

      logger.info({ reservationId: effectiveId, items: normalized.length, expiresAt }, 'Stock reserved via Flow');
      return {
        success: true,
        reservationId: effectiveId,
        expiresAt,
        flowReservationIds: flowReservations.map((r) => r._id),
      };
    } catch (error: unknown) {
      // Release any reservations that were created before the failure
      for (const r of flowReservations) {
        await flow.services.reservation.release(r._id, ctx).catch(() => {});
      }
      if ((error as { code?: string }).code === 'INSUFFICIENT_STOCK') {
        throw new StockReservationError('Insufficient stock to reserve', effectiveId);
      }
      throw error;
    }
  }

  async release(reservationId: string | null): Promise<boolean> {
    if (!reservationId) return false;

    const flow = getFlowEngineOrNull();
    if (!flow) return false;

    try {
      // Find all Flow reservations for this cart/checkout ID
      const branches = await branchRepository.getActiveBranches();
      for (const branch of branches) {
        const ctx = buildFlowContext(String(branch._id));
        const reservations = await flow.repositories.reservation.findByOwner('cart', reservationId, ctx);
        for (const r of reservations) {
          if (r.status === 'active' || r.status === 'partially_consumed') {
            await flow.services.reservation.release(r._id, ctx);
          }
        }
      }

      logger.info({ reservationId }, 'Stock reservation released via Flow');
      return true;
    } catch (error: unknown) {
      logger.error({ err: error, reservationId }, 'Failed to release Flow reservation');
      return false;
    }
  }

  async commitReservation(
    reservationId: string | null,
    reference: AuditReference,
    actorId: string,
  ): Promise<CommitResult> {
    if (!reservationId) throw new StockReservationError('Reservation ID required', reservationId);

    const flow = getFlowEngine();

    // Find the branch that has this reservation
    const branches = await branchRepository.getActiveBranches();
    const allReservations: Array<{
      reservation: { _id: string; status: string; skuRef: string; quantity: number };
      ctx: FlowContext;
      branchId: string;
    }> = [];

    for (const branch of branches) {
      const ctx = buildFlowContext(String(branch._id), actorId);
      const reservations = await flow.repositories.reservation.findByOwner('cart', reservationId, ctx);
      for (const r of reservations) {
        allReservations.push({ reservation: r, ctx, branchId: String(branch._id) });
      }
    }

    if (!allReservations.length) {
      throw new StockReservationError('Reservation not found', reservationId);
    }

    const decrementedItems: unknown[] = [];

    for (const { reservation, ctx } of allReservations) {
      if (reservation.status !== 'active') continue;

      // Consume the reservation
      await flow.services.reservation.consume(reservation._id, reservation.quantity, ctx);

      // Decrement stock (reserve already holds it, now actually move it out)
      const result = await stockTransactionService.decrementBatch(
        [{ productId: reservation.skuRef, quantity: reservation.quantity }],
        ctx.organizationId,
        reference,
        actorId,
      );

      if (result.success) {
        decrementedItems.push(...result.decrementedItems);
      }
    }

    logger.info({ reservationId, items: decrementedItems.length }, 'Reservation committed via Flow');
    return { success: true, decrementedItems };
  }

  async getReservation(reservationId: string | null): Promise<unknown> {
    if (!reservationId) return null;
    const flow = getFlowEngineOrNull();
    if (!flow) return null;

    const branches = await branchRepository.getActiveBranches();
    for (const branch of branches) {
      const ctx = buildFlowContext(String(branch._id));
      const reservations = await flow.repositories.reservation.findByOwner('cart', reservationId, ctx);
      if (reservations.length) return reservations[0];
    }
    return null;
  }

  // ===========================================================================
  // Stock Operations (via stockTransactionService → Flow MoveGroups)
  // ===========================================================================

  async decrement(
    items: StockItem[],
    branchId: string,
    reference: AuditReference,
    actorId: string,
    options: DecrementOptions = {},
  ): Promise<unknown> {
    if (!options.skipValidation) {
      await this.validate(items, branchId);
    }
    const mapped = items.map((i) => ({ ...i, variantSku: i.variantSku ?? undefined }));
    return stockTransactionService.decrementBatch(mapped, branchId, reference, actorId);
  }

  async restore(items: StockItem[], branchId: string, reference: AuditReference, actorId: string): Promise<unknown> {
    const mapped = items.map((i) => ({ ...i, variantSku: i.variantSku ?? undefined }));
    return stockTransactionService.restoreBatch(mapped, branchId, reference, actorId);
  }

  async getActiveReservations(): Promise<unknown[]> {
    const flow = getFlowEngineOrNull();
    if (!flow) return [];

    const branches = await branchRepository.getActiveBranches();
    const all: unknown[] = [];
    for (const branch of branches) {
      const ctx = buildFlowContext(String(branch._id));
      const reservations = await flow.repositories.reservation.findByOwner('cart', '', ctx);
      all.push(...reservations.filter((r: { status: string }) => r.status === 'active'));
    }
    return all;
  }
}

export const stockService = new StockService();
export default stockService;
