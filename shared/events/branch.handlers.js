import { publish, subscribe } from '#lib/events/arcEvents.js';

/**
 * Branch Event Handlers
 *
 * With Better Auth managing branch membership via the `member` collection,
 * these handlers are kept for extensibility (e.g. cache invalidation,
 * audit logging, notifications) but don't sync denormalized data.
 */

export function registerBranchHandlers() {
  subscribe('branch:updated', async (event) => {
    const { branchId, updates } = event.payload || {};
    if (branchId) {
      console.log(`[BranchSync] Branch ${branchId} updated:`, updates);
    }
  });

  subscribe('branch:deleted', async (event) => {
    const { branchId } = event.payload || {};
    if (branchId) {
      console.log(`[BranchSync] Branch ${branchId} deleted`);
    }
  });

  console.log('[EventBus] Branch event handlers registered');
}

export function emitBranchUpdated(branchId, updates) {
  publish('branch:updated', { branchId, updates });
}

export function emitBranchDeleted(branchId) {
  publish('branch:deleted', { branchId });
}

export default { registerBranchHandlers, emitBranchUpdated, emitBranchDeleted };
