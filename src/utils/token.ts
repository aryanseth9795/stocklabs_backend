import jwt from "jsonwebtoken";
import { configData } from "../config/config";
import { NextFunction } from "express";
import ErrorHandler from "../middlewares/ErrorHandler";
import isAuthenticated from "../middlewares/auth";

const secret = process.env.JWT_SECRET || "your-secret";

export const generateToken = (userId: string): string => {
  const secret = configData.JWT_SECRET || "default-secret";
  const payload = { userId };

  const token = jwt.sign(payload, secret, {
    expiresIn: "30d",
  });

  return token;
};


