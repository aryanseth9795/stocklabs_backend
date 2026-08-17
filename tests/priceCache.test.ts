import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  boardCache,
  commodityPriceCache,
  setCommodityPrice,
  setCommodityPriceAt,
  getLivePriceINR,
  tickKey,
  commodityKey,
  MAX_PRICE_AGE_MS,
} from "../src/utils/priceCache.js";
import type { Row } from "../src/types/types.js";

/** `tsMs` defaults to "now" so rows are fresh unless a test deliberately ages
 *  them — the crypto staleness guard reads it on every fill. */
function makeRow(
  symbol: string,
  priceUsd: number,
  priceInr: number,
  tsMs: number = Date.now(),
): Row {
  return {
    stockName: symbol.toLowerCase(),
    stocksymbol: symbol,
    stockPrice: priceUsd,
    stockPriceINR: priceInr,
    stockChange: 0,
    stockChangeINR: 0,
    stockChangePercentage: 0,
    ts: new Date().toISOString(),
    tsMs,
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
 * The crypto half of the staleness rule. `boardCache` entries never expire on
 * their own, so before this guard a dead upstream meant every buy, sell, short
 * and auto-cut filled at a frozen price forever.
 */
describe("crypto prices go stale", () => {
  it("refuses a crypto row older than MAX_PRICE_AGE_MS", () => {
    boardCache.BTCUSDT = makeRow(
      "BTCUSDT",
      60000,
      5040000,
      Date.now() - MAX_PRICE_AGE_MS - 1,
    );
    expect(getLivePriceINR("BTCUSDT", "crypto")).toBeNull();
  });

  it("still fills against a row inside the freshness window", () => {
    boardCache.BTCUSDT = makeRow(
      "BTCUSDT",
      60000,
      5040000,
      Date.now() - (MAX_PRICE_AGE_MS - 5_000),
    );
    expect(getLivePriceINR("BTCUSDT", "crypto")).toBe(5040000);
  });

  it("treats a row with no tsMs as stale, not as fresh", () => {
    // A tick written by a build that predates the field. Trusting it would keep
    // the frozen-price bug alive for exactly as long as such a row survives.
    const legacy = makeRow("ETHUSDT", 3000, 252000) as Partial<Row>;
    delete legacy.tsMs;
    boardCache.ETHUSDT = legacy as Row;

    expect(getLivePriceINR("ETHUSDT", "crypto")).toBeNull();
  });

  it("treats a non-numeric tsMs as stale", () => {
    boardCache.XRPUSDT = {
      ...makeRow("XRPUSDT", 1, 84),
      tsMs: "just now" as unknown as number,
    };
    expect(getLivePriceINR("XRPUSDT", "crypto")).toBeNull();
  });
});

/**
 * Hydration path. A replica that boots cold reads prices out of Redis, and those
 * prices already have an age — stamping them with `Date.now()` would reset the
 * freshness clock and let an 85-second-old quote fill an order.
 */
describe("setCommodityPriceAt preserves the observation time", () => {
  it("does not make an old price look fresh", () => {
    setCommodityPriceAt("PLATINUM", 90_000, Date.now() - 85_000);
    expect(getLivePriceINR("PLATINUM", "commodity")).toBeNull();
  });

  it("accepts a price observed inside the window", () => {
    setCommodityPriceAt("PALLADIUM", 80_000, Date.now() - 5_000);
    expect(getLivePriceINR("PALLADIUM", "commodity")).toBe(80_000);
  });

  it("ignores a junk timestamp instead of substituting now", () => {
    setCommodityPriceAt("NICKEL", 1_500, NaN);
    setCommodityPriceAt("ZINC", 300, 0);
    expect(getLivePriceINR("NICKEL", "commodity")).toBeNull();
    expect(getLivePriceINR("ZINC", "commodity")).toBeNull();
  });

  it("refuses a commodity price that carries no timestamp at all", () => {
    // Written straight into the cache, as a hydrator that bypassed the setter
    // would. The staleness check used to be skipped entirely in this case and
    // the price returned.
    commodityPriceCache.ALUMINIUM = 250;
    expect(getLivePriceINR("ALUMINIUM", "commodity")).toBeNull();
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

  it("commodityKey is uppercase and case-stable for the same reason", () => {
    expect(commodityKey("gold")).toBe("commodity:GOLD");
    expect(commodityKey("GOLD")).toBe("commodity:GOLD");
  });
});
