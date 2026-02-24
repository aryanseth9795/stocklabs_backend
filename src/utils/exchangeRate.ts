/**
 * Dynamic USD/INR exchange rate fetcher.
 * Uses the free open.er-api.com (no key required, 1 500 req/month).
 * Fetches once on startup, then refreshes every 24 hours.
 * Falls back to 86 if the API is unreachable.
 */

const FALLBACK_RATE = 86;
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

let cachedRate: number = FALLBACK_RATE;

async function fetchRate(): Promise<number> {
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const rate = data?.rates?.INR;
    if (typeof rate === "number" && rate > 0) {
      console.log(`[ExchangeRate] USD/INR = ${rate}`);
      return rate;
    }
    throw new Error("INR rate missing from response");
  } catch (err: any) {
    console.warn(
      `[ExchangeRate] Fetch failed, using fallback ${FALLBACK_RATE}:`,
      err.message,
    );
    return FALLBACK_RATE;
  }
}

/** Call once at server startup to seed the rate and start auto-refresh. */
export async function initExchangeRate(): Promise<void> {
  cachedRate = await fetchRate();
  setInterval(async () => {
    cachedRate = await fetchRate();
  }, REFRESH_INTERVAL_MS);
}

/** Returns the latest cached USD → INR rate (never blocks). */
export function getUsdInrRate(): number {
  return cachedRate;
}
