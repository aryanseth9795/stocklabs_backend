import { Request, Response, NextFunction } from "express";
import ErrorHandler from "./ErrorHandler.js";
import jwt from "jsonwebtoken";

import { UserPayload } from "../interface/userInterface.js";

const isAuthenticated = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const token = req.cookies["token"];
  const secret = process.env.JWT_SECRET!;
  if (!token) {
    return next(new ErrorHandler("Please login to access this resource", 401));
  }
  
  const decoded= jwt.verify(token, secret);


  if (!decoded) {
    return next(new ErrorHandler("Please login to access this resource", 401));
  }

  if (req.user) req.user.id = decoded.userId;
  else {
    req.user = {
      id: decoded?.userId,
    };
  }
   return next();
};

export default isAuthenticated;
