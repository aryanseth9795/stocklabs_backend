/**
 * Authoritative live-price cache.
 *
 * Trades are filled at the price the SERVER believes, never at a price supplied
 * by the client. Before this existed, every trade endpoint took `rate` straight
 * from the request body, so a user could buy at ₹1 and sell at ₹10,00,000 and
 * mint unlimited balance (see review S-02).
 *
 * Owning both caches here also breaks the import cycle that would otherwise
 * form (app.ts → routes → controllers → app.ts) and replaces the
 * `setBoardCacheRef` back-reference that autoCutJob.ts previously needed.
 *
 * Writers:
 *   • `boardCache`          ← the Binance WebSocket relay in app.ts
 *   • `commodityPriceCache` ← the commodity SSE relay in commodityController.ts
 */

import type { Row } from "../types/types.js";

/** Latest crypto tick per uppercase symbol, e.g. "BTCUSDT". */
export const boardCache: Record<string, Row> = {};

/** Latest commodity price in ₹ per symbol, e.g. "GOLD". */
export const commodityPriceCache: Record<string, number> = {};

/** Most recent time each commodity symbol was updated (epoch ms). */
const commodityUpdatedAt: Record<string, number> = {};

/**
 * A price older than this is treated as unusable. Filling an order against a
 * stale quote is how a disconnected upstream turns into free money for whoever
 * noticed first.
 */
export const MAX_PRICE_AGE_MS = 60_000;

export type AssetType = "crypto" | "commodity";

export function setCommodityPrice(symbol: string, price: number): void {
  if (!Number.isFinite(price) || price <= 0) return;
  commodityPriceCache[symbol] = price;
  commodityUpdatedAt[symbol] = Date.now();
}

/**
 * Current fill price in ₹ for a symbol, or `null` when the server has no fresh
 * quote. Callers must treat `null` as "reject the order" — never as "fall back
 * to whatever the client asked for".
 */
export function getLivePriceINR(
  symbol: string,
  assetType: AssetType = "crypto",
): number | null {
  if (!symbol) return null;

  if (assetType === "commodity") {
    const key = symbol.toUpperCase();
    const price = commodityPriceCache[key];
    if (!Number.isFinite(price) || price <= 0) return null;

    const updatedAt = commodityUpdatedAt[key];
    if (updatedAt && Date.now() - updatedAt > MAX_PRICE_AGE_MS) return null;

    return price;
  }

  const row = boardCache[symbol.toUpperCase()];
  if (!row) return null;

  // INR is the unit every order, balance and short position is denominated in.
  const price = row.stockPriceINR;
  return Number.isFinite(price) && price > 0 ? price : null;
}

/** Snapshot of the board in a fixed symbol order, skipping symbols not yet seen. */
export function boardSnapshot(symbols: readonly string[]): Row[] {
  const out: Row[] = [];
  for (const s of symbols) {
    const row = boardCache[s];
    if (row) out.push(row);
  }
  return out;
}

/** Redis key for a symbol's cached tick. Single definition so readers and
 *  writers cannot drift apart, which is exactly what happened in S-14. */
export function tickKey(symbol: string): string {
  return `tick:${symbol.toLowerCase()}`;
}
