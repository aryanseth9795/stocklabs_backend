import { Request, Response, NextFunction } from "express";
import ErrorHandler from "./ErrorHandler.js";
import { verifyAccessToken } from "../utils/token.js";

/**
 * Authentication middleware that supports BOTH:
 * 1. Cookie-based auth (for web clients)
 * 2. Authorization header (for mobile/API clients)
 */
const isAuthenticated = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  let token: string | undefined;

  // Priority 1: Check Authorization header (Bearer token)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7);
  }

  // Priority 2: Fall back to cookie
  if (!token) {
    token = req.cookies?.token as string | undefined;
  }

  if (!token) {
    return next(new ErrorHandler("Please login to access this resource", 401));
  }

  // Cookie and bearer tokens now share one format and one secret, so a single
  // verification path covers both. The previous legacy fallback verified against
  // a different secret than the one used to sign — see review S-01.
  const decoded = verifyAccessToken(token);
  if (!decoded) {
    return next(new ErrorHandler("Invalid or expired token", 401));
  }

  req.user = { id: decoded.userId };
  return next();
};

export default isAuthenticated;
