// utils/generateToken.js
import jwt from "jsonwebtoken";
import config from "#config/index.js";

export const generateTokens = (user) => {
  const tokenPayload = {
    id: user._id,
    name: user.name,
    email: user.email,
    roles: user.roles || ['user'],
    organizations: user.organizations || [], // All organizations with flattened data
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
