import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { CacheConfig } from '../../config/domains/cache.config';
import { Clock } from '../../common/time/clock';
import { dateKeyOf, purchaseBusinessDates } from '../analytics-dates';

/** The cache entry of one day's snapshot (the event listener drops it when a document changes the day). */
export const dashboardCacheKey = (shopId: string, dateKey: Date) => `dashboard:${shopId}:${dateKey.toISOString()}`;

@Injectable()
export class AnalyticsDashboardService {
  constructor(private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private readonly cacheConfig: CacheConfig,
    private readonly clock: Clock,
  ) {}

  /**
   * Retrieves the pre-calculated daily snapshot from the OLAP table.
   * If not present, falls back to a safe approximation and enqueues a cache refresh job.
   */
  /** `date` is a `YYYY-MM-DD` business date; without one, today in the shop's time zone (release audit #26). */
  async getDashboardSnapshot(shopId: string, date?: string) {
    const requested = date ? dateKeyOf(date) : null;
    if (date && !requested) throw new BadRequestException({ message: 'date must be a YYYY-MM-DD calendar date.', code: 'INVALID_DATE' });
    const normalizedDate = requested ?? (await purchaseBusinessDates(this.prisma, shopId, this.clock.now())).dateKey;
    const cacheKey = dashboardCacheKey(shopId, normalizedDate);
    
    const cached = await this.cacheManager.get(cacheKey);
    if (cached) return cached;

    const snapshot = await this.prisma.purchaseAnalyticsSnapshot.findUnique({
      where: { shopId_date: { shopId, date: normalizedDate } }
    });

    if (!snapshot) {
      // Do not fabricate zero-filled dashboards.
      return null;
    }

    await this.cacheManager.set(cacheKey, snapshot, this.cacheConfig.analyticsDashboardTtlMs); // 5 min cache
    return snapshot;
  }
}
