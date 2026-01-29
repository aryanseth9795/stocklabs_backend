import jwt from "jsonwebtoken";

const accessSecret = process.env.JWT_SECRET || "aryanseth";
const refreshSecret = process.env.JWT_REFRESH_SECRET || "aryanseth_refresh";

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

// Legacy function for backward compatibility with existing cookie-based auth
export const generateToken = (userId: string): string => {
  return jwt.sign({ userId }, accessSecret, {
    expiresIn: "30d",
  });
};
