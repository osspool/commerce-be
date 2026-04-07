import { defineResource } from '@classytic/arc';
import { requireAuth } from '@classytic/arc/permissions';
import type { PermissionCheck } from '@classytic/arc/permissions';
import platformConfigController from './platform.controller.js';
import { platformActions } from '#shared/permissions.js';
import { roles } from '#config/permissions/roles.js';
import permissions from '#config/permissions/index.js';
import { policies } from '#shared/permissions.js';

// ─── Permission Matrix Introspection ────────────────────────────────────────

type PermissionType = 'public' | 'authenticated' | 'roles';

interface PermissionEntry {
  type: PermissionType;
  roles: string[];
}

function introspectCheck(check: PermissionCheck): PermissionEntry {
  if ((check as any)._isPublic) return { type: 'public', roles: [] };
  if ((check as any)._roles) return { type: 'roles', roles: [...(check as any)._roles] };
  return { type: 'authenticated', roles: [] };
}

function introspectModule(mod: Record<string, unknown>): Record<string, PermissionEntry> {
  const result: Record<string, PermissionEntry> = {};
  for (const [action, check] of Object.entries(mod)) {
    if (typeof check === 'function') {
      result[action] = introspectCheck(check as PermissionCheck);
    } else if (typeof check === 'object' && check !== null) {
      // Nested module (e.g., promotions.programs)
      const nested = introspectModule(check as Record<string, unknown>);
      for (const [nestedAction, entry] of Object.entries(nested)) {
        result[`${action}.${nestedAction}`] = entry;
      }
    }
  }
  return result;
}

function buildPermissionMatrix() {
  const allRoles = Object.values(roles);

  // Introspect config/permissions (domain-level)
  const modules: Record<string, Record<string, PermissionEntry>> = {};
  for (const [moduleName, mod] of Object.entries(permissions)) {
    if (typeof mod === 'object' && mod !== null) {
      modules[moduleName] = introspectModule(mod as Record<string, unknown>);
    }
  }

  // Introspect shared/permissions policies (resource CRUD)
  for (const [resourceName, policy] of Object.entries(policies)) {
    if (modules[resourceName]) continue; // domain-level takes priority
    if (typeof policy === 'object' && policy !== null) {
      modules[resourceName] = introspectModule(policy as Record<string, unknown>);
    }
  }

  return { roles: allRoles, modules };
}

// Cache the matrix — permission config is static, no need to recompute
let cachedMatrix: ReturnType<typeof buildPermissionMatrix> | null = null;

// ─── Resource Definition ────────────────────────────────────────────────────

const platformResource = defineResource({
  name: 'platform',
  displayName: 'Platform',
  tag: 'Platform',
  prefix: '/platform',

  disableDefaultRoutes: true,

  additionalRoutes: [
    {
      method: 'GET',
      path: '/config',
      summary: 'Get platform configuration',
      description: 'Returns full config or selected fields via ?select=field1,field2',
      permissions: platformActions.getConfig,
      wrapHandler: false,
      handler: platformConfigController.getConfig.bind(platformConfigController) as any,
    },
    {
      method: 'PATCH',
      path: '/config',
      summary: 'Update platform configuration',
      permissions: platformActions.updateConfig,
      wrapHandler: false,
      handler: platformConfigController.updateConfig.bind(platformConfigController),
    },
    {
      method: 'GET',
      path: '/permissions/matrix',
      summary: 'Get permission matrix for all roles and modules',
      description: 'Returns the full RBAC matrix introspected from the backend permission config. Single source of truth for frontend permission UIs.',
      permissions: requireAuth(),
      wrapHandler: false,
      handler: async (_req: any, reply: any) => {
        if (!cachedMatrix) cachedMatrix = buildPermissionMatrix();
        return reply.send({ success: true, data: cachedMatrix });
      },
    },
  ],
});

export default platformResource;
