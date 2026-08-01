import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  boardCache,
  commodityPriceCache,
  setCommodityPrice,
  getLivePriceINR,
  tickKey,
  MAX_PRICE_AGE_MS,
} from "../src/utils/priceCache.js";
import type { Row } from "../src/types/types.js";

function makeRow(symbol: string, priceUsd: number, priceInr: number): Row {
  return {
    stockName: symbol.toLowerCase(),
    stocksymbol: symbol,
    stockPrice: priceUsd,
    stockPriceINR: priceInr,
    stockChange: 0,
    stockChangeINR: 0,
    stockChangePercentage: 0,
    ts: new Date().toISOString(),
  };
}

beforeEach(() => {
  for (const k of Object.keys(boardCache)) delete boardCache[k];
  for (const k of Object.keys(commodityPriceCache)) delete commodityPriceCache[k];
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Supports S-02 — the server, not the client, decides the fill price.
 * `null` must mean "refuse the order", never "fall back to client input".
 */
describe("S-02: getLivePriceINR", () => {
  it("returns null for a symbol the server has never seen", () => {
    expect(getLivePriceINR("BTCUSDT", "crypto")).toBeNull();
    expect(getLivePriceINR("GOLD", "commodity")).toBeNull();
  });

  it("returns the INR price for crypto, not the USD price", () => {
    // Orders, balances and short positions are all denominated in INR.
    boardCache.BTCUSDT = makeRow("BTCUSDT", 60000, 5040000);
    expect(getLivePriceINR("BTCUSDT", "crypto")).toBe(5040000);
  });

  it("is case-insensitive on the symbol", () => {
    boardCache.BTCUSDT = makeRow("BTCUSDT", 60000, 5040000);
    expect(getLivePriceINR("btcusdt", "crypto")).toBe(5040000);
  });

  it("returns null for a non-positive or non-finite cached price", () => {
    boardCache.ETHUSDT = makeRow("ETHUSDT", 0, 0);
    expect(getLivePriceINR("ETHUSDT", "crypto")).toBeNull();

    boardCache.XRPUSDT = makeRow("XRPUSDT", 1, NaN);
    expect(getLivePriceINR("XRPUSDT", "crypto")).toBeNull();
  });

  it("returns a fresh commodity price", () => {
    setCommodityPrice("GOLD", 161668);
    expect(getLivePriceINR("GOLD", "commodity")).toBe(161668);
  });

  it("refuses a stale commodity price rather than filling against it", () => {
    vi.useFakeTimers();
    setCommodityPrice("SILVER", 265350);
    expect(getLivePriceINR("SILVER", "commodity")).toBe(265350);

    vi.advanceTimersByTime(MAX_PRICE_AGE_MS + 1);
    expect(getLivePriceINR("SILVER", "commodity")).toBeNull();
  });

  it("ignores junk writes to the commodity cache", () => {
    setCommodityPrice("COPPER", NaN);
    setCommodityPrice("CRUDEOIL", -5);
    expect(getLivePriceINR("COPPER", "commodity")).toBeNull();
    expect(getLivePriceINR("CRUDEOIL", "commodity")).toBeNull();
  });

  it("returns null for an empty symbol", () => {
    expect(getLivePriceINR("", "crypto")).toBeNull();
  });
});

/**
 * Regression test for S-14 — the Redis snapshot reader appended "-ticker" to a
 * key the writer never used, so every read returned null.
 */
describe("S-14: tickKey is the single key definition", () => {
  it("produces a lowercase key with no stream suffix", () => {
    expect(tickKey("BTCUSDT")).toBe("tick:btcusdt");
    expect(tickKey("btcusdt")).toBe("tick:btcusdt");
  });

  it("agrees between the write path and the read path", () => {
    // Writer uses row.stockName (already lowercase); reader uses the BOARD
    // symbol (uppercase). Both must land on the same key.
    const writerKey = tickKey("btcusdt");
    const readerKey = tickKey("BTCUSDT");
    expect(writerKey).toBe(readerKey);
  });
});
