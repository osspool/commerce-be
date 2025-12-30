/**
 * Unified Workflow Helpers
 * Common patterns for monetization workflows across all modules
 * Single source of truth for workflow operations
 */

import mongoose from 'mongoose';
import { createModuleLoader } from '#core/utils/lazy-import.js';

const Organization = () => mongoose.model('Organization');
const loadPlatformConfigUtils = createModuleLoader('#shared/utils/platform-config.utils.js');

/**
 * Get organization payment snapshot (tenantSnapshot)
 * Used by all paid workflows for audit trail and payment instructions
 */
export async function getOrganizationSnapshot(organizationId) {
  const org = await Organization()
    .findById(organizationId)
    .select('config.wallets config.bankAccounts config.contact')
    .lean();

  if (!org) {
    throw new Error('Organization not found');
  }

  const wallets = org.config?.wallets || [];
  const bankAccounts = org.config?.bankAccounts || [];

  const bkashWallet = wallets.find(w => w.type === 'bkash');
  const nagadWallet = wallets.find(w => w.type === 'nagad');
  const primaryBank = bankAccounts[0];

  return {
    paymentInstructions: org.config?.contact?.supportHours || '',
    bkashNumber: bkashWallet?.number || '',
    nagadNumber: nagadWallet?.number || '',
    bankAccount: primaryBank ? `${primaryBank.bankName} - ${primaryBank.accountNumber}` : '',
  };
}

/**
 * Execute workflow with MongoDB transaction
 * Handles session management, commit/rollback automatically
 */
export async function withTransaction(workflowFn) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const result = await workflowFn(session);
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
 * Format payment info for manual provider
 * Converts tenantSnapshot to paymentInfo format expected by @classytic/revenue-manual
 *
 * @param {Object} tenantSnapshot - Payment account snapshot from organization
 * @param {string} referenceCode - Reference code for customer to use (e.g., membershipCode)
 * @returns {Object} Payment info for manual provider metadata
 */
export function formatPaymentInfo(tenantSnapshot, referenceCode = null) {
  const paymentInfo = {};

  // Add bKash if available
  if (tenantSnapshot.bkashNumber) {
    paymentInfo.bkash = tenantSnapshot.bkashNumber;
  }

  // Add Nagad if available
  if (tenantSnapshot.nagadNumber) {
    paymentInfo.nagad = tenantSnapshot.nagadNumber;
  }

  // Add bank account if available
  if (tenantSnapshot.bankAccount) {
    paymentInfo.bank = tenantSnapshot.bankAccount;
  }

  // Add reference code/instructions
  if (referenceCode) {
    paymentInfo.reference = `Use code: ${referenceCode}`;
  }

  if (tenantSnapshot.paymentInstructions) {
    paymentInfo.note = tenantSnapshot.paymentInstructions;
  }

  return paymentInfo;
}

/**
 * Get platform payment info for platform subscriptions
 * Uses database config to get Brihot/Fitverse platform payment accounts
 *
 * @param {string} referenceCode - Optional reference for organization
 * @returns {Promise<Object>} Payment info for manual provider metadata
 */
export async function getPlatformPaymentInfo(referenceCode = null) {
  const { getPlatformConfig } = await loadPlatformConfigUtils();
  const config = await getPlatformConfig();

  const paymentInfo = {};

  // Add bKash if configured
  if (config.payment?.bkash?.accountNumber) {
    paymentInfo.bkash = `${config.payment.bkash.accountNumber} (${config.payment.bkash.accountType})`;
  }

  // Add Nagad if configured
  if (config.payment?.nagad?.accountNumber) {
    paymentInfo.nagad = `${config.payment.nagad.accountNumber} (${config.payment.nagad.accountType})`;
  }

  // Add bank if configured
  if (config.payment?.bank?.accountNumber) {
    paymentInfo.bank = `${config.payment.bank.bankName} - ${config.payment.bank.accountNumber}`;
  }

  // Add reference if provided
  if (referenceCode) {
    paymentInfo.reference = `Org ID: ${referenceCode}`;
  }

  paymentInfo.note = `Pay to ${config.platformName || 'Platform'}`;

  return paymentInfo;
}

/**
 * Format workflow response consistently
 * All workflows return the same structure
 */
export function formatWorkflowResponse(entity, transaction = null, metadata = {}) {
  return {
    [entity.constructor.modelName.toLowerCase()]: entity.toObject ? entity.toObject() : entity,
    transaction: transaction?.toObject ? transaction.toObject() : transaction,
    ...metadata,
  };
}
