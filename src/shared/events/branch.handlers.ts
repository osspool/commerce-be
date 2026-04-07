import { publish, subscribe } from '#lib/events/arcEvents.js';
import type { DomainEvent } from '@classytic/arc/events';

/**
 * Branch Event Handlers
 *
 * With Better Auth managing branch membership via the `member` collection,
 * these handlers are kept for extensibility (e.g. cache invalidation,
 * audit logging, notifications) but don't sync denormalized data.
 */

interface BranchPayload {
  branchId?: string;
  updates?: Record<string, unknown>;
}

export function registerBranchHandlers(): void {
  subscribe('branch:updated', async (event: DomainEvent) => {
    const payload = event.payload as BranchPayload | undefined;
    const { branchId, updates } = payload || {};
    if (branchId) {
      console.log(`[BranchSync] Branch ${branchId} updated:`, updates);
    }
  });

  subscribe('branch:deleted', async (event: DomainEvent) => {
    const payload = event.payload as BranchPayload | undefined;
    const { branchId } = payload || {};
    if (branchId) {
      console.log(`[BranchSync] Branch ${branchId} deleted`);
    }
  });

  console.log('[EventBus] Branch event handlers registered');
}

export function emitBranchUpdated(branchId: string, updates: Record<string, unknown>): void {
  publish('branch:updated', { branchId, updates });
}

export function emitBranchDeleted(branchId: string): void {
  publish('branch:deleted', { branchId });
}

export default { registerBranchHandlers, emitBranchUpdated, emitBranchDeleted };
