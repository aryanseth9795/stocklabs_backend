import { Request, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
import ErrorHandler from "./ErrorHandler.js";
import { isDevelopment } from "../config/env.js";

/**
 * Central error handler.
 *
 * Two problems this replaces (review S-08):
 *  1. Controllers threw plain `Error`s, which carry no statusCode, so every
 *     business rule ("Insufficient balance") surfaced as a 500. Clients could
 *     not tell a user mistake from a server outage, and retry-on-5xx logic
 *     retried operations that could never succeed.
 *  2. `err.message` was echoed unconditionally, so Prisma's internal text —
 *     query fragments, column names — was returned to the caller.
 *
 * Now: deliberate `ErrorHandler`s pass through verbatim; anything else is
 * logged in full server-side and reported generically.
 */
const errorMiddleware = (
  err: Error & { statusCode?: number },
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  // Deliberate, user-facing errors: safe to return as-is.
  if (err instanceof ErrorHandler) {
    res
      .status(err.statusCode || 400)
      .json({ success: false, message: err.message });
    return;
  }

  // Prisma errors we can map to something meaningful without leaking detail.
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    console.error(`[Error] Prisma ${err.code}:`, err.message);

    if (err.code === "P2002") {
      res
        .status(409)
        .json({ success: false, message: "That record already exists" });
      return;
    }
    if (err.code === "P2025") {
      res.status(404).json({ success: false, message: "Record not found" });
      return;
    }
    res.status(400).json({ success: false, message: "Invalid request data" });
    return;
  }

  // Anything else is unexpected. Log everything, tell the client nothing —
  // except in development, where the message is what makes it debuggable.
  console.error("[Error] Unhandled:", err);

  res.status(err.statusCode || 500).json({
    success: false,
    message: isDevelopment
      ? err.message || "Internal Server Error"
      : "Internal Server Error",
  });
};

export default errorMiddleware;
