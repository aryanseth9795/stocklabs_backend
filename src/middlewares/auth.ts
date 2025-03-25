import { Request, Response, NextFunction } from "express";
import ErrorHandler from "./ErrorHandler";
import jwt, { JwtPayload } from "jsonwebtoken";

import { UserPayload, AuthenticatedRequest } from "../interface/userInterface";

const isAuthenticated = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  const token = req.headers.authorization;
  const secret = process.env.JWT_SECRET;

  if (!token) {
    return next(new ErrorHandler("Please login to access this resource", 401));
  }

  if (!secret) {
    return next(new ErrorHandler("Please login to access this resource", 401));
  }

  const decoded: UserPayload = jwt.verify(token, secret);

  if (!decoded) {
    return next(new ErrorHandler("Please login to access this resource", 401));
  }

  req.user.id = decoded;
  next();
};

export default isAuthenticated;
