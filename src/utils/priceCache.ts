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

/**
 * Record a commodity price that was observed at a KNOWN instant.
 *
 * This overload exists for the Redis paths. A replica that boots cold hydrates
 * commodity prices out of Redis, and those values already have an age — routing
 * them through `setCommodityPrice` would stamp `Date.now()` and reset the
 * freshness clock, so an 85-second-old quote would pass the 60 s guard below and
 * the very next order would fill against it. That is the stale-fill bug the
 * guard exists to prevent, reintroduced on every replica restart.
 *
 * `tsMs` is validated exactly like `price`: a junk timestamp is no more usable
 * than a junk price, and silently substituting "now" for one is how the bug
 * above gets back in.
 */
export function setCommodityPriceAt(
  symbol: string,
  price: number,
  tsMs: number,
): void {
  if (!Number.isFinite(price) || price <= 0) return;
  if (!Number.isFinite(tsMs) || tsMs <= 0) return;
  commodityPriceCache[symbol] = price;
  commodityUpdatedAt[symbol] = tsMs;
}

/** Record a commodity price observed right now — the live-feed path. */
export function setCommodityPrice(symbol: string, price: number): void {
  setCommodityPriceAt(symbol, price, Date.now());
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

    // `!updatedAt ||`, not `updatedAt &&`: a price with no timestamp is a price
    // of unknown age, and the previous form skipped the staleness check
    // ENTIRELY for it — returning the stale quote instead of refusing it. Every
    // writer stamps a timestamp today, but Redis hydration is precisely the path
    // that can produce a value whose clock we never set.
    const updatedAt = commodityUpdatedAt[key];
    if (!updatedAt || Date.now() - updatedAt > MAX_PRICE_AGE_MS) return null;

    return price;
  }

  const row = boardCache[symbol.toUpperCase()];
  if (!row) return null;

  // Crypto gets the same staleness rule as commodities. `boardCache` is a plain
  // in-memory object whose entries never expire, so a dead upstream leaves the
  // last tick sitting there forever: the Redis keys TTL out, but every buy,
  // sell, short entry, short cover and midnight auto-cut would keep executing at
  // a frozen price indefinitely.
  //
  // A missing or non-numeric `tsMs` counts as STALE, not fresh — otherwise ticks
  // written by a build that predates the field would be trusted forever, which
  // is the same bug wearing a different hat.
  if (
    !Number.isFinite(row.tsMs) ||
    Date.now() - row.tsMs > MAX_PRICE_AGE_MS
  ) {
    return null;
  }

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

/** Redis key for a commodity's cached price. Same rationale as tickKey: one
 *  definition, so the feed that writes it and the replica that hydrates from it
 *  cannot drift apart. Uppercase because that is the case the cache is keyed by. */
export function commodityKey(symbol: string): string {
  return `commodity:${symbol.toUpperCase()}`;
}
