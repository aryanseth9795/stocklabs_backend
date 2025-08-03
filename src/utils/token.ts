import jwt from "jsonwebtoken";

import { NextFunction } from "express";
import ErrorHandler from "../middlewares/ErrorHandler.js";
import isAuthenticated from "../middlewares/auth.js";

const secret = process.env.JWT_SECRET || "your-secret";

export const generateToken = (userId: string): string => {
  const secret = process.env.JWT_SECRET || "default-secret";
  const payload = { userId };

  const token = jwt.sign(payload, secret, {
    expiresIn: "30d",
  });

  return token;
};


