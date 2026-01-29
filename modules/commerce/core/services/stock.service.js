/**
 * Stock Validation & Reservation Service
 *
 * Centralized stock operations with:
 * - Pre-checkout validation
 * - Reservation system (prevents double-booking)
 * - Consistency checks
 *
 * Inspired by Stripe's inventory handling and Netflix's resilience patterns.
 */

import crypto from 'crypto';
import mongoose from 'mongoose';
import inventoryRepository from '#modules/inventory/inventory.repository.js';
import { stockTransactionService } from '#modules/inventory/index.js';
import branchRepository from '../../branch/branch.repository.js';
import logger from '#lib/utils/logger.js';
import StockReservation from '../models/stockReservation.model.js';
import { StockEntry, StockMovement } from '#modules/inventory/stock/models/index.js';

// Inline constants (minimal)
const RESERVATION_TTL_MINUTES = 15;
const RESERVATION_STATUS = {
  PENDING: 'pending',
  ACTIVE: 'active',
  COMMITTED: 'committed',
  RELEASED: 'released',
  EXPIRED: 'expired',
  RELEASING: 'releasing', // Temporary status during cleanup (prevents race conditions)
};
const CLEANUP_AFTER_DAYS = 14;

/**
 * Stock validation error - thrown when items are out of stock
 */
export class StockValidationError extends Error {
  constructor(unavailableItems) {
    const message = unavailableItems.map(i =>
      `${i.productName || i.productId}: need ${i.requested}, have ${i.available}`
    ).join('; ');
    super(`Insufficient stock: ${message}`);
    this.name = 'StockValidationError';
    this.statusCode = 400;
    this.code = 'INSUFFICIENT_STOCK';
    this.unavailableItems = unavailableItems;
  }
}

/**
 * Stock reservation error
 */
class StockReservationError extends Error {
  constructor(message, reservationId) {
    super(message);
    this.name = 'StockReservationError';
    this.statusCode = 409;
    this.code = 'RESERVATION_ERROR';
    this.reservationId = reservationId;
  }
}

class StockService {
  constructor() {
    this._reservationCleanupInterval = null;
  }

  async _emitInventoryUpdate(stockEntryDoc, context = {}) {
    if (!stockEntryDoc) return;
    const result = typeof stockEntryDoc.toObject === 'function' ? stockEntryDoc.toObject() : stockEntryDoc;
    await inventoryRepository.emitAsync('after:update', { result, context }).catch(() => {});
  }

  /**
   * Ensure cleanup job is running (lazy initialization)
   */
  _ensureCleanupRunning() {
    if (this._reservationCleanupInterval) return;

    // Clean up expired reservations every minute
    this._reservationCleanupInterval = setInterval(() => {
      this._cleanupExpiredReservations().catch(() => {});
    }, 60000);

    // Don't prevent process exit
    this._reservationCleanupInterval.unref();
  }

  _normalizeReservationItems(items) {
    return (items || [])
      .filter(Boolean)
      .map(i => ({
        productId: i.productId?.toString?.() || String(i.productId),
        variantSku: i.variantSku || null,
        quantity: Number(i.quantity),
        productName: i.productName,
      }))
      .filter(i => i.productId && Number.isFinite(i.quantity) && i.quantity > 0);
  }

  _hashReservationPayload({ branchId, items }) {
    const normalized = {
      branchId: branchId?.toString?.() || String(branchId),
      items: (items || []).map(i => ({
        productId: i.productId?.toString?.() || String(i.productId),
        variantSku: i.variantSku || null,
        quantity: Number(i.quantity),
      })).sort((a, b) => {
        const ak = `${a.productId}_${a.variantSku || 'null'}`;
        const bk = `${b.productId}_${b.variantSku || 'null'}`;
        return ak.localeCompare(bk);
      }),
    };
    return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
  }

  _isTransactionNotSupportedError(error) {
    const message = String(error?.message || '');
    return (
      message.includes('Transaction numbers are only allowed on a replica set member') ||
      message.includes('replica set') ||
      message.includes('mongos')
    );
  }

  // ===========================================================================
  // Stock Validation
  // ===========================================================================

  /**
   * Validate stock availability for items
   *
   * @param {Array} items - Items to validate [{ productId, variantSku, quantity, productName }]
   * @param {string} branchId - Branch ID
   * @param {Object} [options] - Validation options
   * @param {boolean} [options.throwOnFailure=true] - Throw error if validation fails
   * @returns {Promise<{ valid: boolean, unavailable: Array }>}
   * @throws {StockValidationError} If throwOnFailure=true and validation fails
   */
  async validate(items, branchId, options = {}) {
    const { throwOnFailure = true } = options;

    if (!items?.length) {
      return { valid: true, unavailable: [] };
    }

    // Resolve branch
    const branch = branchId || (await branchRepository.getDefaultBranch())._id;

    // Get all stock in single query
    const normalizedItems = this._normalizeReservationItems(items);
    const productIds = [...new Set(normalizedItems.map(i => i.productId))];
    const stockMap = await inventoryRepository.getBatchBranchStock(productIds, branch);

    const unavailable = [];

    for (const item of normalizedItems) {
      const key = `${item.productId}_${item.variantSku || 'null'}`;
      const entry = stockMap.get(key);
      const quantity = entry?.quantity || 0;
      const reservedQuantity = entry?.reservedQuantity || 0;
      const effectiveAvailable = quantity - reservedQuantity;

      if (effectiveAvailable < item.quantity) {
        unavailable.push({
          productId: item.productId,
          productName: item.productName,
          variantSku: item.variantSku,
          requested: item.quantity,
          available: Math.max(0, effectiveAvailable),
          reserved: reservedQuantity,
          shortage: item.quantity - effectiveAvailable,
        });
      }
    }

    const result = { valid: unavailable.length === 0, unavailable };

    if (!result.valid && throwOnFailure) {
      throw new StockValidationError(unavailable);
    }

    return result;
  }

  /**
   * Quick check if single item is in stock
   *
   * @param {string} productId - Product ID
   * @param {string} variantSku - Variant SKU (null for simple)
   * @param {number} quantity - Requested quantity
   * @param {string} branchId - Branch ID
   * @returns {Promise<boolean>}
   */
  async isAvailable(productId, variantSku, quantity, branchId) {
    const result = await this.validate(
      [{ productId, variantSku, quantity }],
      branchId,
      { throwOnFailure: false }
    );
    return result.valid;
  }

  // ===========================================================================
  // Stock Reservation (Prevents Double-Booking)
  // ===========================================================================

  /**
   * Reserve stock for cart/checkout
   *
   * Creates a temporary hold on stock to prevent overselling
   * when multiple users checkout simultaneously.
   *
   * @param {string} reservationId - Unique ID (cart ID, session ID)
   * @param {Array} items - Items to reserve
   * @param {string} branchId - Branch ID
   * @param {number} [ttlMinutes] - Reservation TTL in minutes
   * @returns {Promise<{ success: boolean, reservationId: string, expiresAt: Date }>}
   */
  async reserve(reservationId, items, branchId, ttlMinutes = RESERVATION_TTL_MINUTES) {
    this._ensureCleanupRunning();

    const effectiveReservationId = reservationId || crypto.randomUUID();
    const branch = branchId || (await branchRepository.getDefaultBranch())._id;
    const normalizedItems = this._normalizeReservationItems(items);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
    const payloadHash = this._hashReservationPayload({ branchId: branch, items: normalizedItems });

    if (!normalizedItems.length) {
      throw new StockReservationError('No items to reserve', effectiveReservationId);
    }

    // Validate before reserving (available = quantity - reservedQuantity)
    await this.validate(normalizedItems, branch, { throwOnFailure: true });

    // Idempotent behavior for repeated calls
    const existing = await StockReservation.findOne({ reservationId: effectiveReservationId }).lean();
    if (existing) {
      const samePayload = existing.payloadHash === payloadHash;
      if (!samePayload) {
        throw new StockReservationError('Reservation payload mismatch', effectiveReservationId);
      }
      if (existing.status === RESERVATION_STATUS.ACTIVE && new Date() <= new Date(existing.expiresAt)) {
        return { success: true, reservationId: effectiveReservationId, expiresAt: existing.expiresAt };
      }
      if (existing.status === RESERVATION_STATUS.COMMITTED) {
        return { success: true, reservationId: effectiveReservationId, expiresAt: existing.expiresAt, committed: true };
      }
      if ([RESERVATION_STATUS.RELEASED, RESERVATION_STATUS.EXPIRED].includes(existing.status)) {
        throw new StockReservationError(`Reservation is ${existing.status}`, effectiveReservationId);
      }
      if (existing.status === RESERVATION_STATUS.PENDING) {
        throw new StockReservationError('Reservation is pending', effectiveReservationId);
      }
    }

    // Create reservation as PENDING first to avoid "reservedQuantity leak without record"
    await StockReservation.create({
      reservationId: effectiveReservationId,
      branchId: branch,
      items: normalizedItems.map(i => ({
        productId: i.productId,
        variantSku: i.variantSku || null,
        quantity: i.quantity,
      })),
      status: RESERVATION_STATUS.PENDING,
      payloadHash,
      expiresAt,
    });

    // Prefer transaction when available
    let session = null;
    try {
      session = await mongoose.startSession();
      session.startTransaction();
    } catch {
      session = null;
    }

    const updatedEntries = [];
    try {
      for (const item of normalizedItems) {
        const updated = await StockEntry.findOneAndUpdate(
          {
            product: item.productId,
            variantSku: item.variantSku || null,
            branch,
            isActive: { $ne: false },
            $expr: { $gte: ['$quantity', { $add: ['$reservedQuantity', item.quantity] }] },
          },
          { $inc: { reservedQuantity: item.quantity } },
          { new: true, ...(session ? { session } : {}) }
        );

        if (!updated) {
          throw new StockReservationError('Insufficient stock to reserve', effectiveReservationId);
        }
        updatedEntries.push({ id: updated._id, quantity: item.quantity, doc: updated });
      }

      await StockReservation.updateOne(
        { reservationId: effectiveReservationId },
        { $set: { status: RESERVATION_STATUS.ACTIVE } },
        { ...(session ? { session } : {}) }
      );

      if (session) await session.commitTransaction();

      // Emit repository events to invalidate lookup caches (reservedQuantity changes)
      for (const u of updatedEntries) {
        await this._emitInventoryUpdate(u.doc, { skipProductSync: true });
      }

      logger.info({ reservationId: effectiveReservationId, items: normalizedItems.length, expiresAt }, 'Stock reserved');
      return { success: true, reservationId: effectiveReservationId, expiresAt };
    } catch (error) {
      if (session) {
        if (this._isTransactionNotSupportedError(error)) {
          await session.abortTransaction().catch(() => {});
          session.endSession();
          return this._reserveWithoutTransaction(effectiveReservationId, normalizedItems, branch, expiresAt, payloadHash);
        }
        await session.abortTransaction().catch(() => {});
      }

      // Best-effort rollback (no transaction)
      for (const u of updatedEntries) {
        const reverted = await StockEntry.findOneAndUpdate(
          { _id: u.id },
          { $inc: { reservedQuantity: -u.quantity } },
          { new: true }
        ).catch(() => null);
        await this._emitInventoryUpdate(reverted, { skipProductSync: true });
      }

      await StockReservation.updateOne(
        { reservationId: effectiveReservationId },
        {
          $set: {
            status: RESERVATION_STATUS.EXPIRED,
            cleanupAt: new Date(Date.now() + CLEANUP_AFTER_DAYS * 24 * 60 * 60 * 1000),
          },
        }
      ).catch(() => {});

      throw error;
    } finally {
      if (session) session.endSession();
    }
  }

  /**
   * Release stock reservation
   *
   * @param {string} reservationId - Reservation ID to release
   * @returns {boolean} Was reservation found and released
   */
  async release(reservationId, status = RESERVATION_STATUS.RELEASED) {
    if (!reservationId) return false;
    this._ensureCleanupRunning();

    const reservation = await StockReservation.findOne({ reservationId }).lean();
    if (!reservation) return false;
    if (reservation.status === RESERVATION_STATUS.COMMITTED) return false;
    if ([RESERVATION_STATUS.RELEASED, RESERVATION_STATUS.EXPIRED].includes(reservation.status)) return true;

    // 'releasing', 'active', and 'pending' statuses are allowed to proceed with release
    const branch = reservation.branchId;
    const items = reservation.items || [];

    // Prefer transaction when available
    let session = null;
    try {
      session = await mongoose.startSession();
      session.startTransaction();
    } catch {
      session = null;
    }

    const reverted = [];
    try {
      for (const item of items) {
        const updated = await StockEntry.findOneAndUpdate(
          {
            product: item.productId,
            variantSku: item.variantSku || null,
            branch,
            reservedQuantity: { $gte: item.quantity },
          },
          { $inc: { reservedQuantity: -item.quantity } },
          { new: true, ...(session ? { session } : {}) }
        );
        if (!updated) {
          throw new StockReservationError('Failed to release reservation', reservationId);
        }
        reverted.push({ id: updated._id, quantity: item.quantity, doc: updated });
      }

      await StockReservation.updateOne(
        { reservationId },
        {
          $set: {
            status,
            cleanupAt: new Date(Date.now() + CLEANUP_AFTER_DAYS * 24 * 60 * 60 * 1000),
          },
        },
        { ...(session ? { session } : {}) }
      );

      if (session) await session.commitTransaction();

      for (const r of reverted) {
        await this._emitInventoryUpdate(r.doc, { skipProductSync: true });
      }
      logger.info({ reservationId, status }, 'Stock reservation released');
      return true;
    } catch (error) {
      if (session) {
        if (this._isTransactionNotSupportedError(error)) {
          await session.abortTransaction().catch(() => {});
          session.endSession();
          return this._releaseWithoutTransaction(reservationId, status);
        }
        await session.abortTransaction().catch(() => {});
      }

      // Best-effort rollback (no transaction)
      for (const r of reverted) {
        const rolledBack = await StockEntry.findOneAndUpdate(
          { _id: r.id },
          { $inc: { reservedQuantity: r.quantity } },
          { new: true }
        ).catch(() => null);
        await this._emitInventoryUpdate(rolledBack, { skipProductSync: true });
      }
      throw error;
    } finally {
      if (session) session.endSession();
    }
  }

  /**
   * Convert reservation to actual stock decrement
   *
   * @param {string} reservationId - Reservation ID
   * @param {Object} reference - Order reference { model, id }
   * @param {string} actorId - User ID
   * @returns {Promise<{ success: boolean, decrementedItems: Array }>}
   */
  async commitReservation(reservationId, reference, actorId) {
    if (!reservationId) {
      throw new StockReservationError('Reservation ID required', reservationId);
    }

    this._ensureCleanupRunning();

    const reservation = await StockReservation.findOne({ reservationId });
    if (!reservation) {
      throw new StockReservationError('Reservation not found', reservationId);
    }

    if (reservation.status !== RESERVATION_STATUS.ACTIVE) {
      throw new StockReservationError(`Reservation is ${reservation.status}`, reservationId);
    }

    if (new Date() > reservation.expiresAt) {
      await this.release(reservationId, RESERVATION_STATUS.EXPIRED).catch(() => {});
      throw new StockReservationError('Reservation has expired', reservationId);
    }

    // Prefer transaction when available
    let session = null;
    try {
      session = await mongoose.startSession();
      session.startTransaction();
    } catch {
      session = null;
    }

    const decremented = [];
    try {
      for (const item of reservation.items) {
        const updated = await StockEntry.findOneAndUpdate(
          {
            product: item.productId,
            variantSku: item.variantSku || null,
            branch: reservation.branchId,
            isActive: { $ne: false },
            quantity: { $gte: item.quantity },
            reservedQuantity: { $gte: item.quantity },
          },
          { $inc: { quantity: -item.quantity, reservedQuantity: -item.quantity } },
          { new: true, ...(session ? { session } : {}) }
        );

        if (!updated) {
          throw new StockReservationError('Failed to commit reservation', reservationId);
        }

        decremented.push({
          stockEntryId: updated._id,
          productId: item.productId,
          variantSku: item.variantSku || null,
          quantity: item.quantity,
          balanceAfter: updated.quantity,
          doc: updated,
        });
      }

      if (decremented.length) {
        await StockMovement.insertMany(
          decremented.map(d => ({
            stockEntry: d.stockEntryId,
            product: d.productId,
            variantSku: d.variantSku,
            branch: reservation.branchId,
            type: 'sale',
            quantity: -d.quantity,
            balanceAfter: d.balanceAfter,
            reference,
            actor: actorId,
          })),
          { ...(session ? { session } : {}) }
        );
      }

      reservation.status = RESERVATION_STATUS.COMMITTED;
      reservation.cleanupAt = new Date(Date.now() + CLEANUP_AFTER_DAYS * 24 * 60 * 60 * 1000);
      reservation.orderId = reference?.id || reservation.orderId;
      reservation.userId = actorId || reservation.userId;
      await reservation.save({ ...(session ? { session } : {}) });

      if (session) await session.commitTransaction();

      // Emit repository events for cache invalidation + product.quantity sync
      for (const d of decremented) {
        await this._emitInventoryUpdate(d.doc, { quantityDelta: -d.quantity, previousQuantity: d.balanceAfter + d.quantity });
      }

      logger.info({ reservationId }, 'Stock reservation committed');
      return {
        success: true,
        decrementedItems: decremented.map(({ doc, ...rest }) => rest),
      };
    } catch (error) {
      if (session) {
        if (this._isTransactionNotSupportedError(error)) {
          await session.abortTransaction().catch(() => {});
          session.endSession();
          return this._commitReservationWithoutTransaction(reservationId, reference, actorId);
        }
        await session.abortTransaction().catch(() => {});
      }

      // Best-effort rollback (no transaction)
      for (const d of decremented) {
        const rolledBack = await StockEntry.findOneAndUpdate(
          { _id: d.stockEntryId },
          { $inc: { quantity: d.quantity, reservedQuantity: d.quantity } },
          { new: true }
        ).catch(() => null);

        if (rolledBack) {
          const previousQuantity = rolledBack.quantity - d.quantity;
          await this._emitInventoryUpdate(rolledBack, { quantityDelta: d.quantity, previousQuantity });
        }
      }

      throw error;
    } finally {
      if (session) session.endSession();
    }
  }

  /**
   * Get reservation details
   *
   * @param {string} reservationId - Reservation ID
   * @returns {Object|null} Reservation or null
   */
  async getReservation(reservationId) {
    if (!reservationId) return null;
    return StockReservation.findOne({ reservationId }).lean();
  }

  async _reserveWithoutTransaction(reservationId, items, branch, expiresAt, payloadHash) {
    const updatedEntries = [];
    try {
      for (const item of items) {
        const updated = await StockEntry.findOneAndUpdate(
          {
            product: item.productId,
            variantSku: item.variantSku || null,
            branch,
            isActive: { $ne: false },
            $expr: { $gte: ['$quantity', { $add: ['$reservedQuantity', item.quantity] }] },
          },
          { $inc: { reservedQuantity: item.quantity } },
          { new: true }
        );
        if (!updated) throw new StockReservationError('Insufficient stock to reserve', reservationId);
        updatedEntries.push({ id: updated._id, quantity: item.quantity, doc: updated });
      }

      await StockReservation.updateOne(
        { reservationId },
        { $set: { status: RESERVATION_STATUS.ACTIVE, expiresAt, payloadHash } }
      );

      for (const u of updatedEntries) {
        await this._emitInventoryUpdate(u.doc, { skipProductSync: true });
      }
      return { success: true, reservationId, expiresAt };
    } catch (error) {
      for (const u of updatedEntries) {
        const reverted = await StockEntry.findOneAndUpdate(
          { _id: u.id },
          { $inc: { reservedQuantity: -u.quantity } },
          { new: true }
        ).catch(() => null);
        await this._emitInventoryUpdate(reverted, { skipProductSync: true });
      }
      await StockReservation.updateOne(
        { reservationId },
        {
          $set: {
            status: RESERVATION_STATUS.EXPIRED,
            cleanupAt: new Date(Date.now() + CLEANUP_AFTER_DAYS * 24 * 60 * 60 * 1000),
          },
        }
      ).catch(() => {});
      throw error;
    }
  }

  async _releaseWithoutTransaction(reservationId, status) {
    const reservation = await StockReservation.findOne({ reservationId }).lean();
    if (!reservation) return false;
    if (reservation.status === RESERVATION_STATUS.COMMITTED) return false;
    if ([RESERVATION_STATUS.RELEASED, RESERVATION_STATUS.EXPIRED].includes(reservation.status)) return true;

    const reverted = [];
    try {
      for (const item of reservation.items || []) {
        const updated = await StockEntry.findOneAndUpdate(
          {
            product: item.productId,
            variantSku: item.variantSku || null,
            branch: reservation.branchId,
            reservedQuantity: { $gte: item.quantity },
          },
          { $inc: { reservedQuantity: -item.quantity } },
          { new: true }
        );
        if (!updated) throw new StockReservationError('Failed to release reservation', reservationId);
        reverted.push({ id: updated._id, quantity: item.quantity, doc: updated });
      }

      await StockReservation.updateOne(
        { reservationId },
        {
          $set: {
            status,
            cleanupAt: new Date(Date.now() + CLEANUP_AFTER_DAYS * 24 * 60 * 60 * 1000),
          },
        }
      );

      for (const r of reverted) {
        await this._emitInventoryUpdate(r.doc, { skipProductSync: true });
      }
      return true;
    } catch (error) {
      for (const r of reverted) {
        const rolledBack = await StockEntry.findOneAndUpdate(
          { _id: r.id },
          { $inc: { reservedQuantity: r.quantity } },
          { new: true }
        ).catch(() => null);
        await this._emitInventoryUpdate(rolledBack, { skipProductSync: true });
      }
      throw error;
    }
  }

  async _commitReservationWithoutTransaction(reservationId, reference, actorId) {
    const reservation = await StockReservation.findOne({ reservationId });
    if (!reservation) throw new StockReservationError('Reservation not found', reservationId);
    if (reservation.status !== RESERVATION_STATUS.ACTIVE) {
      throw new StockReservationError(`Reservation is ${reservation.status}`, reservationId);
    }
    if (new Date() > reservation.expiresAt) {
      await this.release(reservationId, RESERVATION_STATUS.EXPIRED).catch(() => {});
      throw new StockReservationError('Reservation has expired', reservationId);
    }

    const decremented = [];
    try {
      for (const item of reservation.items) {
        const updated = await StockEntry.findOneAndUpdate(
          {
            product: item.productId,
            variantSku: item.variantSku || null,
            branch: reservation.branchId,
            isActive: { $ne: false },
            quantity: { $gte: item.quantity },
            reservedQuantity: { $gte: item.quantity },
          },
          { $inc: { quantity: -item.quantity, reservedQuantity: -item.quantity } },
          { new: true }
        );
        if (!updated) throw new StockReservationError('Failed to commit reservation', reservationId);
        decremented.push({
          stockEntryId: updated._id,
          productId: item.productId,
          variantSku: item.variantSku || null,
          quantity: item.quantity,
          balanceAfter: updated.quantity,
          doc: updated,
        });
      }

      if (decremented.length) {
        await StockMovement.insertMany(
          decremented.map(d => ({
            stockEntry: d.stockEntryId,
            product: d.productId,
            variantSku: d.variantSku,
            branch: reservation.branchId,
            type: 'sale',
            quantity: -d.quantity,
            balanceAfter: d.balanceAfter,
            reference,
            actor: actorId,
          }))
        );
      }

      reservation.status = RESERVATION_STATUS.COMMITTED;
      reservation.cleanupAt = new Date(Date.now() + CLEANUP_AFTER_DAYS * 24 * 60 * 60 * 1000);
      reservation.orderId = reference?.id || reservation.orderId;
      reservation.userId = actorId || reservation.userId;
      await reservation.save();

      for (const d of decremented) {
        await this._emitInventoryUpdate(d.doc, { quantityDelta: -d.quantity, previousQuantity: d.balanceAfter + d.quantity });
      }

      return {
        success: true,
        decrementedItems: decremented.map(({ doc, ...rest }) => rest),
      };
    } catch (error) {
      for (const d of decremented) {
        const rolledBack = await StockEntry.findOneAndUpdate(
          { _id: d.stockEntryId },
          { $inc: { quantity: d.quantity, reservedQuantity: d.quantity } },
          { new: true }
        ).catch(() => null);

        if (rolledBack) {
          const previousQuantity = rolledBack.quantity - d.quantity;
          await this._emitInventoryUpdate(rolledBack, { quantityDelta: d.quantity, previousQuantity });
        }
      }
      throw error;
    }
  }

  // ===========================================================================
  // Stock Operations (Delegates to stockTransactionService)
  // ===========================================================================

  /**
   * Decrement stock atomically
   * Wrapper around stockTransactionService with validation
   *
   * @param {Array} items - Items to decrement
   * @param {string} branchId - Branch ID
   * @param {Object} reference - Reference { model, id }
   * @param {string} actorId - User ID
   * @param {Object} [options] - Options
   * @param {boolean} [options.skipValidation=false] - Skip pre-validation
   * @returns {Promise<{ success: boolean, decrementedItems: Array }>}
   */
  async decrement(items, branchId, reference, actorId, options = {}) {
    const { skipValidation = false } = options;

    if (!skipValidation) {
      await this.validate(items, branchId);
    }

    return stockTransactionService.decrementBatch(items, branchId, reference, actorId);
  }

  /**
   * Restore stock atomically
   *
   * @param {Array} items - Items to restore
   * @param {string} branchId - Branch ID
   * @param {Object} reference - Reference { model, id }
   * @param {string} actorId - User ID
   * @returns {Promise<{ success: boolean, restoredItems: Array }>}
   */
  async restore(items, branchId, reference, actorId) {
    return stockTransactionService.restoreBatch(items, branchId, reference, actorId);
  }

  /**
   * Clean up expired reservations (multi-instance safe)
   *
   * Uses atomic claim-and-release pattern to prevent race conditions
   * when multiple workers try to clean up the same expired reservations.
   */
  async _cleanupExpiredReservations() {
    const now = new Date();
    let cleaned = 0;
    const maxBatch = 200;

    // Atomically claim and release one reservation at a time
    // This prevents multiple workers from racing on the same reservation
    for (let i = 0; i < maxBatch; i++) {
      // Atomically find and claim one expired reservation
      const reservation = await StockReservation.findOneAndUpdate(
        {
          status: RESERVATION_STATUS.ACTIVE,
          expiresAt: { $lt: now },
        },
        {
          $set: { status: RESERVATION_STATUS.RELEASING }, // Temporary status to claim it
        },
        { new: false, sort: { expiresAt: 1 } } // Oldest first
      );

      if (!reservation) break; // No more expired reservations

      // Release the claimed reservation
      const ok = await this.release(reservation.reservationId, RESERVATION_STATUS.EXPIRED).catch(() => false);
      if (ok) cleaned++;
    }

    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up expired stock reservations');
    }
  }

  /**
   * Get all active reservations (for debugging/monitoring)
   */
  async getActiveReservations() {
    return StockReservation.find({
      status: RESERVATION_STATUS.ACTIVE,
      expiresAt: { $gt: new Date() },
    }).lean();
  }
}

export const stockService = new StockService();
export default stockService;
