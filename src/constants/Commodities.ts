/**
 * The commodities this platform trades.
 *
 * Lifted out of commodityController.ts so that the Redis hydration path can read
 * the symbol list without importing a controller — which would recreate the
 * app.ts → routes → controllers → app.ts cycle that priceCache.ts exists to
 * avoid.
 *
 * This is also the validation allow-list: an order for a symbol absent from here
 * is rejected before it reaches the price cache.
 */
export const COMMODITY_NAMES: Record<string, string> = {
  GOLD: "Gold",
  SILVER: "Silver",
  CRUDEOIL: "Crude Oil",
  COPPER: "Copper",
};

/** Uppercase symbols, in a stable order — the shape MGET hydration wants. */
export const COMMODITY_SYMBOLS = Object.keys(COMMODITY_NAMES);
