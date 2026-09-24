import { Injectable, Inject, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { CacheConfig } from '../../config/domains/cache.config';

export type AnalyticsCacheSection = 'dashboard' | 'kpis' | 'summary';

/**
 * Per-shop cache for dashboard payloads. Keys follow the contract:
 * `shop:{shopId}:analytics:{dashboard|kpis|summary}`; the invoice event
 * processor calls `invalidateAll` after any invoice mutation.
 */
@Injectable()
export class AnalyticsCacheService {
  private readonly logger = new Logger(AnalyticsCacheService.name);

  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly cacheConfig: CacheConfig,
  ) {}

  static key(shopId: string, section: AnalyticsCacheSection): string {
    return `shop:${shopId}:analytics:${section}`;
  }

  async get<T>(shopId: string, section: AnalyticsCacheSection): Promise<T | undefined> {
    const key = AnalyticsCacheService.key(shopId, section);
    try {
      return (await this.cacheManager.get<T>(key)) ?? undefined;
    } catch (error) {
      this.logger.warn(`Cache read failed for ${key}: ${(error as Error).message}`);
      return undefined;
    }
  }

  async set(shopId: string, section: AnalyticsCacheSection, data: unknown, ttlMs: number): Promise<void> {
    const key = AnalyticsCacheService.key(shopId, section);
    try {
      await this.cacheManager.set(key, data, ttlMs);
    } catch (error) {
      this.logger.warn(`Cache write failed for ${key}: ${(error as Error).message}`);
    }
  }

  async setDashboardCache(shopId: string, data: unknown): Promise<void> {
    await this.set(shopId, 'dashboard', data, this.cacheConfig.analyticsDashboardTtlMs);
  }

  async getDashboardCache<T = unknown>(shopId: string): Promise<T | undefined> {
    return this.get<T>(shopId, 'dashboard');
  }

  async setKpis(shopId: string, data: unknown): Promise<void> {
    await this.set(shopId, 'kpis', data, this.cacheConfig.analyticsKpiTtlMs);
  }

  async getKpis<T = unknown>(shopId: string): Promise<T | undefined> {
    return this.get<T>(shopId, 'kpis');
  }

  async invalidateDashboard(shopId: string): Promise<void> {
    await this.del(AnalyticsCacheService.key(shopId, 'dashboard'));
  }

  /** Drops every analytics cache entry of the shop (dashboard, kpis, summary). */
  async invalidateAll(shopId: string): Promise<void> {
    await Promise.all(
      (['dashboard', 'kpis', 'summary'] as const).map((section) => this.del(AnalyticsCacheService.key(shopId, section))),
    );
  }

  private async del(key: string): Promise<void> {
    try {
      await this.cacheManager.del(key);
    } catch (error) {
      this.logger.warn(`Cache delete failed for ${key}: ${(error as Error).message}`);
    }
  }
}
