// utils/generateToken.js
import jwt from "jsonwebtoken";
import config from "#config/index.js";

export const generateTokens = (user) => {
  const resolveExpiresInSeconds = (input) => {
    if (!input) return undefined;
    if (/^\d+$/.test(input)) return parseInt(input, 10);

    const match = /^(\d+)\s*([smhd])$/i.exec(input);
    if (!match) return undefined;

    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (unit === 's') return value;
    if (unit === 'm') return value * 60;
    if (unit === 'h') return value * 60 * 60;
    if (unit === 'd') return value * 60 * 60 * 24;
    return undefined;
  };

  // Get primary branch (from branches array or legacy field)
  const primaryBranch = user.getPrimaryBranch?.() || user.branch || null;

  // Build primary branch payload
  const branchPayload = primaryBranch ? {
    branchId: primaryBranch.branchId?.toString?.() || primaryBranch.branchId,
    branchCode: primaryBranch.branchCode,
    branchName: primaryBranch.branchName,
    branchRole: primaryBranch.branchRole,
    roles: primaryBranch.roles || [],
  } : null;

  // Build full branches array for dashboard/branch switching
  // Each branch includes: branchId, branchCode, branchName, branchRole, roles, isPrimary
  const branches = (user.branches || []).map(b => ({
    branchId: b.branchId?.toString?.() || b.branchId,
    branchCode: b.branchCode,
    branchName: b.branchName,
    branchRole: b.branchRole,
    roles: b.roles || [],
    isPrimary: b.isPrimary || false,
  }));

  // Get all branch IDs user has access to
  const branchIds = user.getBranchIds?.() || [];

  const tokenPayload = {
    id: user._id,
    name: user.name,
    email: user.email,
    roles: user.roles || ['user'],
    // Branch info
    branch: branchPayload,        // Primary/active branch
    branches,                     // All assigned branches with roles
    branchIds,                    // Quick lookup array of branch IDs
    // Employee flags
    isAdmin: user.isAdmin?.() || false,
    isWarehouseStaff: user.isWarehouseStaff?.() || false,
    isActive: user.isActive,
  };

  const accessExpiresIn = config.app.jwtExpiresIn || "1d";
  const refreshExpiresIn = config.app.jwtRefreshExpiresIn || "7d";

  const token = jwt.sign(tokenPayload, config.app.jwtSecret, {
    expiresIn: accessExpiresIn,
  });

  const refreshToken = jwt.sign(
    { id: user._id },
    config.app.jwtRefresh,
    { expiresIn: refreshExpiresIn }
  );

  return {
    token,
    refreshToken,
    expiresIn: resolveExpiresInSeconds(accessExpiresIn),
    refreshExpiresIn: resolveExpiresInSeconds(refreshExpiresIn),
  };
};
