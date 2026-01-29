import { Request, Response, NextFunction } from "express";
import ErrorHandler from "./ErrorHandler.js";
import jwt from "jsonwebtoken";
import { UserPayload } from "../interface/userInterface.js";
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

  // Try to verify with the new access token format first
  const decoded = verifyAccessToken(token);
  if (decoded) {
    req.user = { id: decoded.userId };
    return next();
  }

  // Fall back to legacy token format (for existing cookie tokens)
  let legacyDecoded: unknown;
  try {
    legacyDecoded = jwt.verify(token, process.env.JWT_SECRET!);
  } catch {
    return next(new ErrorHandler("Invalid or expired token", 401));
  }

  if (
    !legacyDecoded ||
    typeof legacyDecoded === "string" ||
    !(legacyDecoded as any).userId
  ) {
    return next(new ErrorHandler("Invalid token payload", 401));
  }

  const { userId } = legacyDecoded as UserPayload;
  req.user = { id: userId };
  return next();
};

export default isAuthenticated;
