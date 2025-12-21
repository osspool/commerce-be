import User from '#modules/auth/user.model.js';
import { eventBus } from './eventBus.js';

/**
 * Branch Event Handlers
 *
 * Handles branch-related events to keep denormalized data in sync.
 *
 * Events handled:
 * - branch:updated - Sync branch details to all assigned users
 * - branch:deleted - Remove branch from all users' assignments
 * - branch:roleChanged - Update branch role in user assignments
 *
 * Design:
 * - Uses updateMany for bulk operations (efficient)
 * - Non-blocking (async handlers)
 * - Idempotent (safe to replay)
 */

/**
 * Sync branch details to all users assigned to that branch
 *
 * When a branch's name, code, or role changes, update the denormalized
 * data in all User documents that reference this branch.
 *
 * @param {Object} payload - Event payload
 * @param {string} payload.branchId - Branch ID that was updated
 * @param {Object} payload.updates - Updated fields
 * @param {string} [payload.updates.code] - New branch code
 * @param {string} [payload.updates.name] - New branch name
 * @param {string} [payload.updates.role] - New branch role (head_office/sub_branch)
 */
async function handleBranchUpdated({ branchId, updates }) {
  if (!branchId || !updates) return;

  try {
    const result = await User.syncBranchDetails(branchId, updates);

    if (result.modifiedCount > 0) {
      console.log(
        `[BranchSync] Updated ${result.modifiedCount} users for branch ${branchId}`
      );
    }
  } catch (error) {
    console.error('[BranchSync] Failed to sync branch updates:', error);
  }
}

/**
 * Remove branch from all users when branch is deleted
 *
 * @param {Object} payload - Event payload
 * @param {string} payload.branchId - Branch ID that was deleted
 */
async function handleBranchDeleted({ branchId }) {
  if (!branchId) return;

  try {
    // Remove from branches array
    const result = await User.updateMany(
      { 'branches.branchId': branchId },
      { $pull: { branches: { branchId } } }
    );

    // Clear legacy branch field if it matches
    await User.updateMany(
      { 'branch.branchId': branchId },
      { $unset: { branch: 1 } }
    );

    if (result.modifiedCount > 0) {
      console.log(
        `[BranchSync] Removed branch ${branchId} from ${result.modifiedCount} users`
      );
    }
  } catch (error) {
    console.error('[BranchSync] Failed to handle branch deletion:', error);
  }
}

/**
 * Register all branch event handlers
 *
 * Call this once during application startup to register handlers.
 */
export function registerBranchHandlers() {
  eventBus.on('branch:updated', handleBranchUpdated);
  eventBus.on('branch:deleted', handleBranchDeleted);

  console.log('[EventBus] Branch sync handlers registered');
}

/**
 * Emit branch updated event
 *
 * Convenience function for emitting branch updates from other modules.
 *
 * @param {string} branchId - Branch ID
 * @param {Object} updates - Updated fields (code, name, role)
 */
export function emitBranchUpdated(branchId, updates) {
  eventBus.emitBranchEvent('updated', { branchId, updates });
}

/**
 * Emit branch deleted event
 *
 * @param {string} branchId - Branch ID
 */
export function emitBranchDeleted(branchId) {
  eventBus.emitBranchEvent('deleted', { branchId });
}

export default {
  registerBranchHandlers,
  emitBranchUpdated,
  emitBranchDeleted,
};
