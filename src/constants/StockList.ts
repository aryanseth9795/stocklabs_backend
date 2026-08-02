/**
 * Fixed Top-50 crypto pairs by market-cap, uppercase, USDT quotes.
 * You can rearrange or trim without touching server code.
 *
 * IMPORTANT: every entry must be a live `TRADING` USDT pair on Binance **spot**
 * (`api.binance.com/api/v3/exchangeInfo`). Binance silently ignores unknown
 * streams in a combined subscription rather than rejecting the connection, so a
 * stale symbol here does not fail loudly — it just never produces a tick, and
 * the board quietly renders fewer than 50 cards.
 *
 * That is exactly what happened: nine entries were dead futures-only symbols and
 * the board had been running on 40 of 50 for some time. Validated against spot
 * exchangeInfo when this list was last changed — re-validate before editing.
 *
 * Renamed by Binance: MATIC→POL, RNDR→RENDER, FTM→S.
 * Delisted with no successor (replaced with liquid majors): MKR, EOS, KAS, BSV,
 * OKB, MNT.
 */
export const TOP50 = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "SHIBUSDT", "TRXUSDT",
  "DOTUSDT", "LINKUSDT", "POLUSDT", "WBTCUSDT", "ICPUSDT",
  "LTCUSDT", "BCHUSDT", "UNIUSDT", "ATOMUSDT", "ETCUSDT",
  "HBARUSDT", "FILUSDT", "XLMUSDT", "ARBUSDT", "APTUSDT",
  "IMXUSDT", "ONDOUSDT", "VETUSDT", "PEPEUSDT", "WLDUSDT",
  "RENDERUSDT", "TAOUSDT", "GRTUSDT", "NEARUSDT", "INJUSDT",
  "OPUSDT",  "TIAUSDT", "QNTUSDT", "AAVEUSDT", "SUIUSDT",
  "ENAUSDT", "ALGOUSDT", "JUPUSDT", "STXUSDT", "SEIUSDT",
  "FETUSDT", "AXSUSDT", "FLOWUSDT", "SUSDT", "MANAUSDT"
];
