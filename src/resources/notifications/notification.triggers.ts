/**
 * Notification Trigger Registry
 *
 * Single declarative config for every notification the system can emit.
 * Adding a new notification = adding one entry here. Nothing else to touch.
 *
 * Each trigger defines:
 *   - which Arc event it listens to
 *   - the in-app template (title, message, link)
 *   - which roles receive it
 *   - how to extract variables from the event payload
 *   - priority and email behavior
 *
 * The handler loop in notification.handlers.ts reads this registry
 * and auto-subscribes to every configured event.
 */

// ============================================
// TYPES
// ============================================

export interface NotificationTrigger {
  /** Arc event name to subscribe to (e.g. 'order:created') */
  event: string;

  /** Notification type — defaults to event name if omitted */
  type?: string;

  /** In-app notification template */
  template: {
    title: string;
    message: string;
    /** Frontend route with {variable} placeholders */
    link?: string;
    /** Entity type for badge/icon grouping */
    entityType?: string;
  };

  /** Roles that should receive this notification. '*' = all branch members. */
  recipients: string[];

  /** Priority level (default: 'normal') */
  priority?: 'low' | 'normal' | 'high';

  /** Also send email via @classytic/notifications (default: false) */
  sendEmail?: boolean;

  /**
   * Extract dispatch variables from the Arc event payload.
   * Must return { organizationId, variables, triggeredBy? }.
   * If organizationId is missing, the notification is skipped.
   */
  extract: (payload: Record<string, any>) => {
    organizationId: string;
    variables: Record<string, string>;
    triggeredBy?: string;
  } | null;
}

// ============================================
// TRIGGER REGISTRY
// ============================================

export const NOTIFICATION_TRIGGERS: NotificationTrigger[] = [
  // ── Orders ──────────────────────────────────────────────

  {
    event: 'order:created',
    template: {
      title: 'New Order #{orderNumber}',
      message: '{customerName} placed an order for {amount}',
      link: '/dashboard/orders/{orderId}',
      entityType: 'order',
    },
    recipients: ['admin', 'branch_manager', 'store-manager'],
    extract: (p) => ({
      organizationId: p.organizationId,
      variables: {
        orderId: p.orderId || p._id,
        orderNumber: p.orderNumber || '',
        customerName: p.customerName || 'Customer',
        amount: p.amount || p.total || '',
      },
      triggeredBy: p.triggeredBy || p.customerId,
    }),
  },

  {
    event: 'order:status-changed',
    template: {
      title: 'Order #{orderNumber} updated',
      message: 'Order status changed to {status}',
      link: '/dashboard/orders/{orderId}',
      entityType: 'order',
    },
    recipients: ['admin', 'branch_manager', 'store-manager'],
    extract: (p) => ({
      organizationId: p.organizationId,
      variables: {
        orderId: p.orderId || p._id,
        orderNumber: p.orderNumber || '',
        status: p.status || p.newStatus || '',
      },
      triggeredBy: p.triggeredBy,
    }),
  },

  {
    event: 'order:cancel-requested',
    template: {
      title: 'Cancel requested for #{orderNumber}',
      message: '{customerName} requested cancellation',
      link: '/dashboard/orders/{orderId}',
      entityType: 'order',
    },
    recipients: ['admin', 'branch_manager', 'store-manager'],
    priority: 'high',
    extract: (p) => ({
      organizationId: p.organizationId,
      variables: {
        orderId: p.orderId || p._id,
        orderNumber: p.orderNumber || '',
        customerName: p.customerName || 'Customer',
      },
      triggeredBy: p.triggeredBy || p.customerId,
    }),
  },

  // ── Transfers ───────────────────────────────────────────

  {
    event: 'transfer:created',
    template: {
      title: 'New Transfer',
      message: 'Transfer from {senderBranch} to {receiverBranch}',
      link: '/dashboard/inventory/transfers/{transferId}',
      entityType: 'transfer',
    },
    recipients: ['admin', 'warehouse-admin'],
    extract: (p) => ({
      organizationId: p.receiverBranchId || p.organizationId,
      variables: {
        transferId: p.transferId || p._id,
        docNumber: p.docNumber || '',
        senderBranch: p.senderBranch || '',
        receiverBranch: p.receiverBranch || '',
      },
      triggeredBy: p.triggeredBy,
    }),
  },

  {
    event: 'transfer:approved',
    template: {
      title: 'Transfer Approved',
      message: 'Transfer {docNumber} has been approved',
      link: '/dashboard/inventory/transfers/{transferId}',
      entityType: 'transfer',
    },
    recipients: ['admin', 'warehouse-admin', 'warehouse-staff'],
    extract: (p) => ({
      organizationId: p.receiverBranchId || p.organizationId,
      variables: {
        transferId: p.transferId || p._id,
        docNumber: p.docNumber || '',
        senderBranch: p.senderBranch || '',
        receiverBranch: p.receiverBranch || '',
      },
      triggeredBy: p.triggeredBy,
    }),
  },

  {
    event: 'transfer:dispatched',
    template: {
      title: 'Transfer Dispatched',
      message: 'Transfer {docNumber} shipped from {senderBranch}',
      link: '/dashboard/inventory/transfers/{transferId}',
      entityType: 'transfer',
    },
    recipients: ['admin', 'warehouse-admin', 'warehouse-staff'],
    extract: (p) => ({
      organizationId: p.receiverBranchId || p.organizationId,
      variables: {
        transferId: p.transferId || p._id,
        docNumber: p.docNumber || '',
        senderBranch: p.senderBranch || '',
        receiverBranch: p.receiverBranch || '',
      },
      triggeredBy: p.triggeredBy,
    }),
  },

  {
    event: 'transfer:received',
    template: {
      title: 'Transfer Received',
      message: 'Transfer {docNumber} received at {receiverBranch}',
      link: '/dashboard/inventory/transfers/{transferId}',
      entityType: 'transfer',
    },
    recipients: ['admin', 'warehouse-admin'],
    extract: (p) => ({
      organizationId: p.senderBranchId || p.organizationId,
      variables: {
        transferId: p.transferId || p._id,
        docNumber: p.docNumber || '',
        senderBranch: p.senderBranch || '',
        receiverBranch: p.receiverBranch || '',
      },
      triggeredBy: p.triggeredBy,
    }),
  },

  // ── Stock ───────────────────────────────────────────────

  {
    event: 'stock:low',
    template: {
      title: 'Low Stock Alert',
      message: '{productName} is low on stock ({quantity} remaining)',
      link: '/dashboard/inventory',
      entityType: 'product',
    },
    recipients: ['admin', 'warehouse-admin', 'store-manager'],
    priority: 'high',
    sendEmail: true,
    extract: (p) => ({
      organizationId: p.organizationId,
      variables: {
        productId: p.productId || '',
        productName: p.productName || '',
        quantity: String(p.quantity ?? '0'),
      },
    }),
  },

  // ── Purchases ──────────────────────────────────────────

  {
    event: 'purchase:received',
    template: {
      title: 'Purchase Received',
      message: 'Purchase {invoiceNumber} has been received',
      link: '/dashboard/inventory/purchases',
      entityType: 'purchase',
    },
    recipients: ['admin', 'branch_manager', 'inventory_staff'],
    extract: (p) => ({
      organizationId: p.organizationId,
      variables: {
        purchaseId: p.purchaseId || p._id || '',
        invoiceNumber: p.invoiceNumber || '',
      },
      triggeredBy: p.triggeredBy,
    }),
  },

  // ── Inventory ─────────────────────────────────────────

  {
    event: 'stock:adjusted',
    template: {
      title: 'Stock Adjusted',
      message: '{count} item(s) adjusted by {actor}',
      link: '/dashboard/inventory/movements',
      entityType: 'inventory',
    },
    recipients: ['admin', 'branch_manager', 'inventory_staff'],
    extract: (p) => ({
      organizationId: p.organizationId,
      variables: {
        count: String(p.count || '1'),
        actor: p.actorName || 'Staff',
      },
      triggeredBy: p.triggeredBy,
    }),
  },

  // ── Team ────────────────────────────────────────────────

  {
    event: 'member:joined',
    template: {
      title: 'New Team Member',
      message: '{userName} joined {branchName}',
      link: '/dashboard/settings',
      entityType: 'member',
    },
    recipients: ['admin'],
    extract: (p) => ({
      organizationId: p.organizationId,
      variables: {
        userName: p.userName || p.name || '',
        branchName: p.branchName || p.organizationName || '',
      },
      triggeredBy: p.userId,
    }),
  },
];

// ============================================
// HELPERS
// ============================================

/** Get a trigger by its event name. */
export function getTriggerByEvent(event: string): NotificationTrigger | undefined {
  return NOTIFICATION_TRIGGERS.find((t) => t.event === event);
}

/** Get all registered event names (for docs / admin UI). */
export function getRegisteredEvents(): string[] {
  return NOTIFICATION_TRIGGERS.map((t) => t.event);
}

/** Get the recipient matrix (for admin UI). */
export function getRecipientMatrix(): Record<string, string[]> {
  const matrix: Record<string, string[]> = {};
  for (const t of NOTIFICATION_TRIGGERS) {
    matrix[t.type || t.event] = t.recipients;
  }
  return matrix;
}
