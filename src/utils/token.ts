import jwt from "jsonwebtoken";
import { configData } from "../config/config";
import { NextFunction } from "express";
import ErrorHandler from "../middlewares/ErrorHandler";

const secret = process.env.JWT_SECRET || "your-secret";

export const generateToken = (userId: string): string => {
  const secret = configData.JWT_SECRET || "default-secret";
  const payload = { userId };

  const token = jwt.sign(payload, secret, {
    expiresIn: "30d",
  });

  return token;
};

export const verifyToken = (token: string, next:NextFunction): string | jwt.JwtPayload => {
  const secret = configData.JWT_SECRET || "default-secret";
  try {             
    const decoded = jwt.verify(token, secret);
    return decoded;
  } catch (error) {  
    next(new ErrorHandler("Invalid or expired token", 401));
    return "Invalid or expired token";
  }
};   

