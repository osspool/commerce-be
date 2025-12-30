/**
 * MongoDB Utilities
 * Reusable patterns for MongoDB operations
 */

import mongoose from 'mongoose';

/**
 * Execute function within MongoDB transaction
 * Handles session creation, commit, abort, and cleanup
 *
 * @param {Function} callback - Async function to execute (receives session)
 * @returns {Promise<any>} - Result from callback
 *
 * @example
 * const result = await withTransaction(async (session) => {
 *   const order = await Order.create([orderData], { session });
 *   const transaction = await Transaction.create([txnData], { session });
 *   return { order, transaction };
 * });
 */
export async function withTransaction(callback) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const result = await callback(session);
    await session.commitTransaction();
    return result;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
}

/**
 * Execute function within MongoDB transaction (alternative name)
 * Same as withTransaction, but more explicit naming
 */
export const withMongoTransaction = withTransaction;

export default {
  withTransaction,
  withMongoTransaction,
};
