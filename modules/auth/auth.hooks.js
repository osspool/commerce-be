/**
 * Organization Hooks — Member Lifecycle
 *
 * Handles post-invitation events for branch management.
 */

export const authHooks = {
  afterAcceptInvitation: async ({ invitation, member, user, organization }) => {
    console.log(`[auth] ${user.name} accepted invitation to ${organization.name} as ${member.role}`);
  },

  afterCancelInvitation: async ({ invitation, cancelledBy, organization }) => {
    console.log(`[auth] Invitation to ${organization.name} cancelled`);
  },
};
