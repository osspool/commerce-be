/**
 * Organization Hooks — Member Lifecycle
 *
 * Wired into BA's organization plugin via organizationHooks config.
 * Handles notifications after invitation acceptance.
 */

import { notify } from '#shared/notifications/index.js';

interface InvitationHookData {
  invitation: Record<string, unknown>;
  member: { role: string; [key: string]: unknown };
  user: { name: string; email: string; [key: string]: unknown };
  organization: { name: string; [key: string]: unknown };
}

export const authHooks = {
  afterAcceptInvitation: async ({
    member,
    user,
    organization,
  }: InvitationHookData): Promise<void> => {
    const roles = typeof member.role === 'string'
      ? member.role.split(',').map((r) => r.trim()).join(', ')
      : String(member.role);

    console.log(
      `[auth] ${user.name} accepted invitation to ${organization.name} as ${roles}`,
    );

    // Notify the new member
    await notify('invitation_accepted', user.email, {
      userName: user.name,
      orgName: organization.name,
      roles,
    }).catch((err) => {
      console.error('[auth] Failed to send acceptance notification:', err);
    });
  },
};
