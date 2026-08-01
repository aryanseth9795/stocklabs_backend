/**
 * Input validation for trade endpoints.
 *
 * `ExecuteOrder` previously did no validation at all: a negative quantity made
 * `cost` negative, sailed past the `balance < cost` check, and *credited* the
 * user while writing a negative position (see review S-05).
 */

import ErrorHandler from "../middlewares/ErrorHandler.js";

/** Generous upper bound — high enough never to block a real paper trade,
 *  low enough that a fat-fingered or hostile value cannot overflow arithmetic. */
export const MAX_QUANTITY = 1_000_000_000;

/**
 * Coerces and validates a trade quantity.
 * Accepts a number or a numeric string; rejects anything non-finite,
 * non-positive, or absurdly large.
 */
export function validateQuantity(value: unknown, field = "quantity"): number {
  const n = typeof value === "string" ? Number(value.trim()) : value;

  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new ErrorHandler(`${field} must be a valid number`, 400);
  }
  if (n <= 0) {
    throw new ErrorHandler(`${field} must be greater than zero`, 400);
  }
  if (n > MAX_QUANTITY) {
    throw new ErrorHandler(
      `${field} exceeds the maximum of ${MAX_QUANTITY}`,
      400,
    );
  }
  return n;
}

/** Validates a value that must be one of a fixed set. */
export function validateEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ErrorHandler(
      `${field} must be one of: ${allowed.join(", ")}`,
      400,
    );
  }
  return value as T;
}

/** Validates a non-empty string field and returns it trimmed. */
export function validateString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ErrorHandler(`${field} is required`, 400);
  }
  return value.trim();
}

/** Minimal, permissive email shape check — rejects the obviously malformed
 *  without trying to out-clever RFC 5322. */
export function validateEmail(value: unknown): string {
  const email = validateString(value, "email").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ErrorHandler("Please provide a valid email address", 400);
  }
  return email;
}
