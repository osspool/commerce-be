// utils/generateToken.js
import jwt from "jsonwebtoken";
import config from "#config/index.js";

export const generateTokens = (user) => {
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

  const token = jwt.sign(tokenPayload, config.app.jwtSecret, {
    expiresIn: config.app.jwtExpiresIn || "1d",
  });

  const refreshToken = jwt.sign(
    { id: user._id },
    config.app.jwtRefresh,
    { expiresIn: config.app.jwtRefreshExpiresIn || "7d" }
  );

  return { token, refreshToken };
};
