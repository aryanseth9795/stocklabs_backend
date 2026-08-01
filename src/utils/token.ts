import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

// Secrets come from the validated env module — never from a hardcoded fallback.
// See review S-01: reading process.env directly here resolved to `undefined` and
// silently fell back to a literal in source, because ESM evaluates this module
// before app.ts calls dotenv's config().
const accessSecret = env.JWT_SECRET;
const refreshSecret = env.JWT_REFRESH_SECRET;

// Access token: short-lived (15 minutes)
export const generateAccessToken = (userId: string): string => {
  return jwt.sign({ userId, type: "access" }, accessSecret, {
    expiresIn: "15m",
  });
};

// Refresh token: long-lived (7 days)
export const generateRefreshToken = (userId: string): string => {
  return jwt.sign({ userId, type: "refresh" }, refreshSecret, {
    expiresIn: "7d",
  });
};

// Generate both tokens
export const generateTokenPair = (
  userId: string,
): { accessToken: string; refreshToken: string } => {
  return {
    accessToken: generateAccessToken(userId),
    refreshToken: generateRefreshToken(userId),
  };
};

// Verify access token
export const verifyAccessToken = (
  token: string,
): { userId: string; type: string } | null => {
  try {
    const decoded = jwt.verify(token, accessSecret) as {
      userId: string;
      type: string;
    };
    if (decoded.type !== "access") return null;
    return decoded;
  } catch {
    return null;
  }
};

// Verify refresh token
export const verifyRefreshToken = (
  token: string,
): { userId: string; type: string } | null => {
  try {
    const decoded = jwt.verify(token, refreshSecret) as {
      userId: string;
      type: string;
    };
    if (decoded.type !== "refresh") return null;
    return decoded;
  } catch {
    return null;
  }
};

/**
 * Long-lived token stored in the web client's httpOnly cookie (30 days).
 * Carries `type: "access"` so it verifies through the same path as mobile bearer
 * tokens. It previously omitted the claim, which made verifyAccessToken reject it
 * and forced a legacy fallback branch that verified against a different secret.
 */
export const generateToken = (userId: string): string => {
  return jwt.sign({ userId, type: "access" }, accessSecret, {
    expiresIn: "30d",
  });
};
