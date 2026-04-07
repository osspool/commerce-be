/**
 * Better Auth Configuration
 *
 * Authentication and branch-based organization management for BigBoss Commerce.
 * Routes are registered automatically at /api/auth/*
 *
 * Branches are modeled as BA organizations. Staff are org members with roles.
 */

import { betterAuth } from 'better-auth';
import type { BetterAuthOptions } from 'better-auth';
import mongoose from 'mongoose';
import { MongoClient, type Db } from 'mongodb';
import { mongodbAdapter } from '@better-auth/mongo-adapter';
import { organization } from 'better-auth/plugins/organization';
import { bearer } from 'better-auth/plugins/bearer';
import { admin as adminPlugin } from 'better-auth/plugins/admin';
import { adminAc, userAc } from 'better-auth/plugins/admin/access';
import config from '#config/index.js';
import {
  ac,
  branch_manager,
  inventory_staff,
  cashier,
  stock_receiver,
  stock_requester,
  viewer,
} from './access-control.js';
import { notify } from '#shared/notifications/index.js';
import { linkCustomerOnRegistration } from './auth.workflow.js';

let _auth: any = null;
let _mongoClient: MongoClient | null = null;

/**
 * Get a native MongoClient (from the `mongodb` package directly, not mongoose's bundled one).
 * This avoids BSON version mismatch between mongoose's bundled mongodb and @better-auth/mongo-adapter.
 */
function getMongoDb(): Db {
  if (!_mongoClient) {
    _mongoClient = new MongoClient(config.db.uri || 'mongodb://localhost:27017/bigboss');
  }
  return _mongoClient.db();
}

/**
 * Reset the auth singleton (for tests only).
 * Call before creating a new test app to ensure fresh BA instance.
 */
export function resetAuth(): void {
  _auth = null;
  if (_mongoClient) {
    _mongoClient.close().catch(() => {});
    _mongoClient = null;
  }
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

    _auth = betterAuth({
      secret: config.betterAuth.secret,
      baseURL: config.betterAuth.url || `http://localhost:${port}`,
      basePath: '/api/auth',

      database: mongodbAdapter(getMongoDb()),

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
            console.log('[invitation-email] BA data keys:', Object.keys(d));
            console.log('[invitation-email] email:', d.email);
            console.log('[invitation-email] id:', d.id);
            console.log('[invitation-email] role:', d.role);
            console.log('[invitation-email] org:', d.organization?.name);
            console.log('[invitation-email] inviter:', d.inviter?.user?.name || d.inviter?.user?.email);
            const inviteUrl = `${config.app.frontendUrl}/accept-invitation/${d.id}`;
            const roles = Array.isArray(d.role) ? d.role.join(', ') : d.role || 'member';
            try {
              await notify('invitation', d.email, {
                orgName: d.organization?.name || 'Branch',
                roles,
                inviterName: d.inviter?.user?.name || d.inviter?.user?.email || 'Admin',
                inviteUrl,
              });
              console.log('[invitation-email] Sent successfully to', d.email);
            } catch (err: any) {
              console.error('[invitation-email] FAILED:', err.message);
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
                console.log('[auth] New user created:', user.email);
                await linkCustomerOnRegistration(user);
                await notify('welcome', user.email, {
                  name: user.name || 'there',
                  loginUrl: `${config.app.frontendUrl}/sign-in`,
                });
              } catch (err) {
                console.error('[auth] Failed post-user-create hook:', err);
              }
            },
          },
        },
      },
    } satisfies BetterAuthOptions);

    // Register stub Mongoose models for Better Auth's collections
    const baCollections = ['user', 'organization', 'member', 'invitation', 'session', 'account'] as const;
    for (const name of baCollections) {
      if (!mongoose.models[name]) {
        mongoose.model(name, new mongoose.Schema({}, { strict: false, collection: name }));
      }
    }

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
