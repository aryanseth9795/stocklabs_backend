import { describe, it, expect } from "vitest";
import {
  validateQuantity,
  validateEnum,
  validateEmail,
  validateString,
  MAX_QUANTITY,
} from "../src/utils/validate.js";
import ErrorHandler from "../src/middlewares/ErrorHandler.js";

/**
 * Regression tests for S-05 — no numeric validation on trade input.
 *
 * ExecuteOrder previously did no validation at all, so a negative quantity made
 * `cost` negative, passed the balance check, and CREDITED the user.
 */

describe("S-05: validateQuantity", () => {
  it("rejects a negative quantity", () => {
    // The money-printing input.
    expect(() => validateQuantity(-10)).toThrow(ErrorHandler);
    expect(() => validateQuantity(-10)).toThrow(/greater than zero/);
  });

  it("rejects zero", () => {
    expect(() => validateQuantity(0)).toThrow(/greater than zero/);
  });

  it("rejects NaN and Infinity", () => {
    expect(() => validateQuantity(NaN)).toThrow(/valid number/);
    expect(() => validateQuantity(Infinity)).toThrow(/valid number/);
  });

  it("rejects non-numeric input", () => {
    expect(() => validateQuantity("abc")).toThrow(/valid number/);
    expect(() => validateQuantity(null)).toThrow(/valid number/);
    expect(() => validateQuantity(undefined)).toThrow(/valid number/);
    expect(() => validateQuantity({})).toThrow(/valid number/);
  });

  it("rejects absurdly large values", () => {
    expect(() => validateQuantity(MAX_QUANTITY + 1)).toThrow(/maximum/);
  });

  it("accepts a positive number", () => {
    expect(validateQuantity(5)).toBe(5);
    expect(validateQuantity(0.5)).toBe(0.5);
  });

  it("accepts a numeric string and returns a number", () => {
    expect(validateQuantity("5")).toBe(5);
    expect(typeof validateQuantity("5")).toBe("number");
  });

  it("attaches a 400 status code", () => {
    try {
      validateQuantity(-1);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ErrorHandler);
      expect((err as ErrorHandler).statusCode).toBe(400);
    }
  });
});

/**
 * Regression test for S-12 — unvalidated commodity order type falling through
 * to the sell branch.
 */
describe("S-12: validateEnum", () => {
  const allowed = ["buy", "sell", "short_sell"] as const;

  it("rejects a value outside the allow-list", () => {
    // "SELL" used to reach the else branch and execute a real sell.
    expect(() => validateEnum("SELL", allowed, "type")).toThrow(ErrorHandler);
    expect(() => validateEnum("long", allowed, "type")).toThrow(/must be one of/);
    expect(() => validateEnum(undefined, allowed, "type")).toThrow();
  });

  it("accepts and narrows an allowed value", () => {
    expect(validateEnum("buy", allowed, "type")).toBe("buy");
  });
});

describe("S-18: validateEmail", () => {
  it("normalises case so one address is one account", () => {
    expect(validateEmail("Aryan@Example.COM")).toBe("aryan@example.com");
  });

  it("trims surrounding whitespace", () => {
    expect(validateEmail("  a@b.co  ")).toBe("a@b.co");
  });

  it("rejects malformed addresses", () => {
    expect(() => validateEmail("not-an-email")).toThrow(/valid email/);
    expect(() => validateEmail("a@b")).toThrow(/valid email/);
    expect(() => validateEmail("")).toThrow();
  });
});

describe("validateString", () => {
  it("rejects empty and non-string input", () => {
    expect(() => validateString("", "stockName")).toThrow(/required/);
    expect(() => validateString("   ", "stockName")).toThrow(/required/);
    expect(() => validateString(123, "stockName")).toThrow(/required/);
  });

  it("returns the trimmed value", () => {
    expect(validateString("  BTCUSDT ", "stockName")).toBe("BTCUSDT");
  });
});
