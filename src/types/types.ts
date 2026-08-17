/**
 * A live price tick as broadcast to clients.
 *
 * CURRENCY CONTRACT: the platform trades in rupees. The `*INR` fields are the
 * authoritative ones and the only ones any money calculation may use — fills,
 * balances, cost basis, and P&L, on the server and in both clients.
 *
 * `stockPrice` and `stockChange` are the raw USD values from Binance, carried
 * along for reference and charting context only. Using them in arithmetic
 * against a rupee balance is precisely the bug that made the web app subtract
 * rupees from dollars (see review F-01); the field names are kept so the wire
 * format stays stable, but treat them as display-only.
 *
 * Conversion happens once, in src/utils/exchangeRate.ts, at a fixed rate.
 */
export type Row = {
  stockName: string;
  stocksymbol: string;
  /** USD — informational only, never use for money. */
  stockPrice: number;
  /** ₹ — authoritative price. */
  stockPriceINR: number;
  /** USD — informational only, never use for money. */
  stockChange: number;
  /** ₹ — authoritative 24h change. */
  stockChangeINR: number;
  stockChangePercentage: number;
  /**
   * Display-only clock time of this tick, already formatted in IST.
   *
   * The server runs in UTC, so a bare toLocaleTimeString() rendered every price
   * ~5h30m behind for an audience that is entirely in India. Formatting happens
   * here, once, rather than in each client.
   */
  ts: string;
  /**
   * Same instant as `ts`, as epoch milliseconds.
   *
   * `ts` is a localised string and cannot be compared or sorted, so clients that
   * need "how fresh is this board?" (the single Last-updated line on the
   * dashboard) use this instead of trying to parse the display value.
   */
  tsMs: number;
};
