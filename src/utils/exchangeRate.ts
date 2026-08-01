/**
 * USD → INR conversion rate: a fixed constant.
 *
 * The platform is denominated in rupees end to end — balances, orders, short
 * positions, and both clients. Binance quotes its pairs in USD, so this is the
 * single point where that gets converted, and it is the only place the number
 * should ever appear.
 *
 * Previously this fetched a live rate from open.er-api.com on startup and every
 * 24 hours, falling back to 86 when unreachable. That made pricing depend on a
 * third-party service and, worse, non-deterministic: the same trade could be
 * priced differently across restarts, and a fetch failure silently shifted every
 * price by ~10% (86 vs ~95). A paper-trading platform gains nothing from a
 * live FX rate and loses reproducibility, so the rate is now pinned.
 *
 * NOTE: changing this value does NOT retroactively reprice existing holdings.
 * Cost basis is stored in rupees at the rate that applied when the order filled,
 * which is the correct accounting behaviour — historical fills do not move.
 */

/** Rupees per US dollar. */
export const USD_INR_RATE = 95;

/** Returns the USD → INR rate. Constant; never blocks, never fails. */
export function getUsdInrRate(): number {
  return USD_INR_RATE;
}

/** Converts a USD amount to rupees, rounded to paise. */
export function usdToInr(usd: number): number {
  if (!Number.isFinite(usd)) return 0;
  return +(usd * USD_INR_RATE).toFixed(2);
}
