import { describe, it, expect } from "vitest";
import {
  USD_INR_RATE,
  getUsdInrRate,
  usdToInr,
} from "../src/utils/exchangeRate.js";

/**
 * The USD→INR rate is a pinned constant, not a live lookup.
 *
 * It used to be fetched from a third-party API on startup and refreshed every
 * 24h, with an 86 fallback on failure — so an outage silently shifted every
 * price on the platform by roughly 10%, and the same trade could be priced
 * differently across restarts.
 */
describe("USD/INR rate is a fixed constant", () => {
  it("is pinned at 95", () => {
    expect(USD_INR_RATE).toBe(95);
    expect(getUsdInrRate()).toBe(95);
  });

  it("returns the same value on every call", () => {
    const readings = Array.from({ length: 5 }, () => getUsdInrRate());
    expect(new Set(readings).size).toBe(1);
  });

  it("is not the old fallback that a failed fetch used to produce", () => {
    expect(getUsdInrRate()).not.toBe(86);
  });
});

describe("usdToInr", () => {
  it("converts at the pinned rate", () => {
    expect(usdToInr(1)).toBe(95);
    expect(usdToInr(100)).toBe(9500);
  });

  it("rounds to paise", () => {
    // 0.015 USD × 95 = 1.425 → 1.43
    expect(usdToInr(0.015)).toBe(1.43);
  });

  it("handles negatives, as price changes can be", () => {
    expect(usdToInr(-2)).toBe(-190);
  });

  it("returns 0 for non-finite input rather than NaN", () => {
    // Binance sends strings; a malformed tick must not poison the cache with
    // NaN, which would silently propagate into order totals.
    expect(usdToInr(NaN)).toBe(0);
    expect(usdToInr(Infinity)).toBe(0);
  });

  it("converts a realistic BTC quote", () => {
    // $77,900.10 × 95 = ₹7,400,509.50
    expect(usdToInr(77900.1)).toBe(7400509.5);
  });
});
