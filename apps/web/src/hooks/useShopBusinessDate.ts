'use client';

import { useEffect, useState } from 'react';
import { businessDateIn, shopTimeZone } from '@/lib/business-date';

/**
 * Today's business date in the shop's time zone (`YYYY-MM-DD`), or null until
 * the zone has been read. A page that defaults a date filter to "today" waits
 * for it instead of using the browser's date (audit W16).
 */
export function useShopBusinessDate(): string | null {
  const [date, setDate] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void shopTimeZone().then((timeZone) => {
      if (!cancelled) setDate(businessDateIn(timeZone));
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return date;
}
