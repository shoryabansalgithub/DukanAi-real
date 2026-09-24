import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { businessDateString, startOfBusinessDay } from '../../common/time/business-day';
import { shiftBusinessDays } from '../analytics-range';
import { TrendEngine } from './trend-engine';
import { toMoney } from './invoice-sql';

export const FORECAST_WINDOW_DAYS = 7;

export interface NetRevenueForecast {
  /** Business day the forecast is for (the current business day). */
  businessDate: string;
  forecastNetRevenue: number;
  /** Number of business days in the window that had invoices. */
  basisDays: number;
  confidence: 'LOW' | 'MEDIUM';
  basisFrom: string;
  basisTo: string;
}

/**
 * Simple live moving average of net daily sales (sales minus returns) over
 * the last `FORECAST_WINDOW_DAYS` complete business days, i.e. the window
 * ending yesterday so the partial current day does not drag it down.
 */
@Injectable()
export class ForecastEngine {
  constructor(private readonly trendEngine: TrendEngine) {}

  async forecastNetRevenue(shopId: string, timeZone: string, now: Date = new Date()): Promise<NetRevenueForecast> {
    const todayStart = startOfBusinessDay(now, timeZone);
    const windowStart = shiftBusinessDays(todayStart, -FORECAST_WINDOW_DAYS, timeZone);
    const windowEnd = todayStart;

    const days = await this.trendEngine.dailyNetSalesSparse(shopId, windowStart, windowEnd, timeZone);
    const basisDays = days.length;
    const total = days.reduce((acc, day) => acc.plus(day.sales), new Prisma.Decimal(0));
    const forecast = basisDays > 0 ? total.div(basisDays) : new Prisma.Decimal(0);

    return {
      businessDate: businessDateString(now, timeZone),
      forecastNetRevenue: toMoney(forecast),
      basisDays,
      confidence: basisDays >= FORECAST_WINDOW_DAYS ? 'MEDIUM' : 'LOW',
      basisFrom: businessDateString(windowStart, timeZone),
      basisTo: businessDateString(shiftBusinessDays(todayStart, -1, timeZone), timeZone),
    };
  }
}
