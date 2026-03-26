/**
 * Better Auth Configuration
 *
 * Authentication and branch-based organization management for BigBoss Commerce.
 * Routes are registered automatically at /api/auth/*
 *
 * Branches are modeled as BA organizations. Staff are org members with roles.
 */

import { betterAuth } from 'better-auth';
import mongoose from 'mongoose';
import { MongoClient } from 'mongodb';
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
import { sendResetPasswordEmail, sendInvitationEmail } from './email.js';
import { linkCustomerOnRegistration } from './auth.workflow.js';

let _auth = null;
let _mongoClient = null;

/**
 * Get a native MongoClient (from the `mongodb` package directly, not mongoose's bundled one).
 * This avoids BSON version mismatch between mongoose's bundled mongodb and @better-auth/mongo-adapter.
 */
function getMongoDb() {
  if (!_mongoClient) {
    const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/bigboss';
    _mongoClient = new MongoClient(uri);
  }
  return _mongoClient.db();
}

/**
 * Reset the auth singleton (for tests only).
 * Call before creating a new test app to ensure fresh BA instance.
 */
export function resetAuth() {
  _auth = null;
  if (_mongoClient) {
    _mongoClient.close().catch(() => {});
    _mongoClient = null;
  }
}

/**
 * Get the Better Auth instance (lazy singleton)
 */
export function getAuth() {
  if (
    process.env.NODE_ENV === 'production' &&
    !process.env.BETTER_AUTH_SECRET
  ) {
    throw new Error(
      'BETTER_AUTH_SECRET is required in production (min 32 chars)',
    );
  }

  if (!_auth) {
    const port = config.app.port || 8040;
    const isDev = config.isDevelopment;
    const frontendUrl = config.app.frontendUrl || 'http://localhost:3000';

    _auth = betterAuth({
      secret: process.env.BETTER_AUTH_SECRET,
      baseURL:
        process.env.BETTER_AUTH_URL || `http://localhost:${port}`,
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
        sendResetPassword: async ({ user, url }) => {
          await sendResetPasswordEmail(user, url);
        },
      },

      ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
        ? {
            socialProviders: {
              google: {
                clientId: process.env.GOOGLE_CLIENT_ID,
                clientSecret: process.env.GOOGLE_CLIENT_SECRET,
              },
            },
          }
        : {}),

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
          sendInvitationEmail: async (data) => {
            await sendInvitationEmail(data);
          },
        }),
      ],

      session: {
        expiresIn: 60 * 60 * 24 * 7, // 7 days
        updateAge: 60 * 60 * 24, // 1 day
      },

      trustedOrigins: isDev ? ['*'] : [frontendUrl],

      rateLimit: {
        enabled: config.isProduction,
      },

      databaseHooks: {
        user: {
          create: {
            after: async (user) => {
              try {
                console.log('[auth] New user created:', user.email);
                await linkCustomerOnRegistration(user);
              } catch (err) {
                console.error('[auth] Failed post-user-create hook:', err);
              }
            },
          },
        },
      },
    });

    // Register stub Mongoose models for Better Auth's collections
    const baCollections = ['user', 'organization', 'member', 'invitation', 'session', 'account'];
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

export default getAuth;
