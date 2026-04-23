/**
 * Better Auth Configuration
 *
 * Authentication and branch-based organization management for BigBoss Commerce.
 * Routes are registered automatically at /api/auth/*
 *
 * Branches are modeled as BA organizations. Staff are org members with roles.
 */

import { mongodbAdapter } from '@better-auth/mongo-adapter';
import { registerBetterAuthMongooseModels } from '@classytic/arc/auth/mongoose';
import type { BetterAuthOptions } from 'better-auth';
import { betterAuth } from 'better-auth';
import { admin as adminPlugin } from 'better-auth/plugins/admin';
import { adminAc, userAc } from 'better-auth/plugins/admin/access';
import { bearer } from 'better-auth/plugins/bearer';
import { organization } from 'better-auth/plugins/organization';
import mongoose from 'mongoose';
import pino from 'pino';
import config from '#config/index.js';
import { notify } from '#shared/notifications/index.js';
import {
  ac,
  branch_manager,
  cashier,
  inventory_staff,
  stock_receiver,
  stock_requester,
  viewer,
} from './access-control.js';
import { linkCustomerOnRegistration } from './auth.workflow.js';

const log = pino({ name: 'auth' });

// BA with plugins (organization, bearer, admin) widens the generic beyond
// base `ReturnType<typeof betterAuth>`. Plugin composition makes the exact
// type impractical to declare statically — use the structural shape Arc needs.
let _auth: { handler: (request: Request) => Promise<Response>; api: Record<string, unknown> } | null = null;

/**
 * Reset the auth singleton (for tests only).
 * Call before creating a new test app to ensure fresh BA instance.
 */
export function resetAuth(): void {
  _auth = null;
}

interface BAUser {
  id: string;
  name: string;
  email: string;
  [key: string]: unknown;
}

/**
 * Get the Better Auth instance (lazy singleton)
 */
export function getAuth() {
  if (config.isProduction && !config.betterAuth.secret) {
    throw new Error('BETTER_AUTH_SECRET is required in production (min 32 chars)');
  }

  if (!_auth) {
    const port = config.app.port || 8040;
    const isDev = config.isDevelopment;
    const isTest = config.isTest;
    const frontendUrl = config.app.frontendUrl;

    // Cast needed: BA with plugins (org, bearer, admin) produces a wider
    // generic than base `ReturnType<typeof betterAuth>`.
    _auth = betterAuth({
      secret: config.betterAuth.secret,
      baseURL: config.betterAuth.url || `http://localhost:${port}`,
      basePath: '/api/auth',

      // Reuse Mongoose's connection — no separate MongoClient needed.
      // BA 1.6.2+ accepts mongodb ^7 (same as mongoose 9.4's bundled driver).
      // Cast: commerce packages install via `file:` during local dev, which
      // symlinks their source trees (including their own nested `mongoose`/
      // `mongodb`) into be-prod's resolution path. TypeScript sees two nominal
      // `Db` types from different paths even though they're structurally
      // identical. Disappears once commerce packages publish to npm.
      database: mongodbAdapter(mongoose.connection.getClient().db() as unknown as Parameters<typeof mongodbAdapter>[0]),

      user: {
        additionalFields: {
          role: {
            type: 'string[]',
            defaultValue: ['user'],
            required: false,
            input: false,
          },
          phone: {
            type: 'string',
            required: false,
          },
          isActive: {
            type: 'boolean',
            defaultValue: true,
            required: false,
            input: false,
          },
        },
      },

      emailAndPassword: {
        enabled: true,
        minPasswordLength: 6,
        requireEmailVerification: !isTest,
        sendResetPassword: async ({ user, url }: { user: BAUser; url: string }) => {
          await notify('password_reset', user.email, {
            name: user.name || 'there',
            resetUrl: url,
          });
        },
      },

      emailVerification: {
        sendOnSignUp: true,
        sendVerificationEmail: async ({ user, url }: { user: BAUser; url: string }) => {
          await notify('email_verification', user.email, {
            name: user.name || 'there',
            verificationUrl: url,
          });
        },
        autoSignInAfterVerification: true,
      },

      plugins: [
        bearer(),
        adminPlugin({
          defaultRole: 'user',
          adminRoles: ['superadmin'],
          roles: {
            superadmin: adminAc,
            user: userAc,
          },
        }),
        organization({
          allowUserToCreateOrganization: true, // Controlled by frontend UI — only admin pages expose branch creation
          creatorRole: 'branch_manager',
          membershipLimit: 100,
          ac,
          roles: {
            branch_manager,
            inventory_staff,
            cashier,
            stock_receiver,
            stock_requester,
            viewer,
          },
          schema: {
            organization: {
              additionalFields: {
                code: {
                  type: 'string',
                  required: false,
                },
                branchType: {
                  type: 'string',
                  required: false,
                },
                branchRole: {
                  type: 'string',
                  required: false,
                },
                address: {
                  type: 'string',
                  required: false,
                },
                phone: {
                  type: 'string',
                  required: false,
                },
                isDefault: {
                  type: 'boolean',
                  required: false,
                },
                isActive: {
                  type: 'boolean',
                  required: false,
                },
              },
            },
            member: {
              additionalFields: {
                phone: {
                  type: 'string',
                  required: false,
                },
                status: {
                  type: 'string',
                  required: false,
                  defaultValue: 'active',
                },
              },
            },
          },
          sendInvitationEmail: async (data: Record<string, unknown>) => {
            const d = data as any;
            log.debug({ email: d.email, role: d.role, org: d.organization?.name }, 'Sending invitation email');
            const inviteUrl = `${config.app.frontendUrl}/accept-invitation/${d.id}`;
            const roles = Array.isArray(d.role) ? d.role.join(', ') : d.role || 'member';
            try {
              await notify('invitation', d.email, {
                orgName: d.organization?.name || 'Branch',
                roles,
                inviterName: d.inviter?.user?.name || d.inviter?.user?.email || 'Admin',
                inviteUrl,
              });
              log.info({ email: d.email }, 'Invitation email sent');
            } catch (err: any) {
              log.error({ err, email: d.email }, 'Failed to send invitation email');
            }
          },
        }),
      ],

      session: {
        expiresIn: 60 * 60 * 24 * 7, // 7 days
        updateAge: 60 * 60 * 24, // 1 day
      },

      trustedOrigins: isDev ? ['*'] : [frontendUrl],

      rateLimit: {
        enabled: !isDev && !isTest,
        window: 10,
        max: 100,
        customRules: {
          '/api/auth/sign-up/email': { window: 60, max: 3 },
          '/api/auth/sign-in/email': { window: 60, max: 5 },
          '/api/auth/forget-password': { window: 60, max: 3 },
        },
      },

      databaseHooks: {
        user: {
          create: {
            after: async (user: BAUser) => {
              try {
                log.info({ email: user.email }, 'New user created');
                await linkCustomerOnRegistration(user);
                await notify('welcome', user.email, {
                  name: user.name || 'there',
                  loginUrl: `${config.app.frontendUrl}/sign-in`,
                });
              } catch (err) {
                log.error({ err, email: user.email }, 'Failed post-user-create hook');
              }
            },
          },
        },
      },
    } satisfies BetterAuthOptions);

    // Register stub Mongoose models for Better Auth's collections so that
    // .populate('userId') / ref: 'User' etc. resolve against BA-owned docs.
    // Uses arc 2.7.3's helper — idempotent, strict:false, plugin-aware.
    registerBetterAuthMongooseModels(mongoose, {
      plugins: ['organization'],
      // 'Branch' alias → organization collection for ref: 'Branch' in
      // inventory, order, transfer models.
      modelOverrides: { organization: 'organization' },
      extraCollections: [],
    });

    // Register 'Branch' as an alias model pointing to the 'organization' collection.
    // This makes .populate('branch') / ref: 'Branch' resolve from the organization
    // collection — all existing inventory, order, transfer models work unchanged.
    if (!mongoose.models.Branch) {
      mongoose.model('Branch', new mongoose.Schema({}, { strict: false, collection: 'organization' }));
    }
  }

  return _auth;
}

export type AuthInstance = ReturnType<typeof getAuth>;
export default getAuth;
