/**
 * Calendar-day bucketing in IST.
 *
 * The server runs in UTC and the users are in India. Bucketing by UTC day would
 * file every trade made between 00:00 and 05:30 IST under the previous day — so
 * a late-evening session appears split across two days on the account chart, and
 * "today" looks empty until half past five in the morning.
 *
 * Formatting via `en-CA` because it yields ISO-shaped `YYYY-MM-DD`, which is
 * what the chart's date axis and range filter compare as strings.
 */

const IST_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** `YYYY-MM-DD` for the IST calendar day containing `d`. */
export function istDayKey(d: Date): string {
  return IST_DAY.format(d);
}
