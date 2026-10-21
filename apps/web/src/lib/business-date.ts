import { shopApi } from './api-client';

/** The API's default when a shop has no settings row (`ShopSettings.timezone`). */
const DEFAULT_SHOP_TIME_ZONE = 'Asia/Kolkata';

/**
 * `YYYY-MM-DD` of `now` in `timeZone`: the shop's business date, which is what
 * the API means by "today" in every filter and report (audit W16). The
 * browser's own clock zone never decides it.
 */
export function businessDateIn(timeZone: string, now: Date = new Date()): string {
  try {
    // en-CA formats a date as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_SHOP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  }
}

let timeZoneRead: Promise<string> | null = null;

/** The shop's time zone from `GET /shops/me`, read once per page load (a failed read is retried next time). */
export function shopTimeZone(): Promise<string> {
  if (!timeZoneRead) {
    timeZoneRead = shopApi
      .me()
      .then((profile) => profile.settings.timezone || DEFAULT_SHOP_TIME_ZONE)
      .catch(() => {
        timeZoneRead = null;
        return DEFAULT_SHOP_TIME_ZONE;
      });
  }
  return timeZoneRead;
}
