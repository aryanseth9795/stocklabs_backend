
import { Request, Response, NextFunction } from "express";
import ErrorHandler from "./ErrorHandler.js";
import jwt from "jsonwebtoken";
import { UserPayload } from "../interface/userInterface.js";

const isAuthenticated = (req: Request, _res: Response, next: NextFunction): void => {
  const token = req.cookies?.token as string | undefined;
  if (!token) return next(new ErrorHandler("Please login to access this resource", 401));

  let decoded: unknown;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET!);
  } catch {
    return next(new ErrorHandler("Invalid or expired token", 401));
  }

  if (!decoded || typeof decoded === "string" || !(decoded as any).userId) {
    return next(new ErrorHandler("Invalid token payload", 401));
  }

  const { userId } = decoded as UserPayload;
  req.user = { id: userId };
  return next();
};

export default isAuthenticated;

