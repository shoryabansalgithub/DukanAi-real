import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { SearchFeatureConfig } from '../config/domains/features/search-feature.config';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { clampSearchQuery } from './search-term';

const WINDOW_MS = 60_000;

@Injectable()
export class SearchAnalyticsService {
  private readonly logger = new Logger(SearchAnalyticsService.name);
  /** Per-process fallback counters (`shopId` -> hits in the current minute) when Redis is unavailable. */
  private readonly localWindow = new Map<string, { bucket: number; hits: number }>();
  private degraded = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly searchFeatureConfig: SearchFeatureConfig,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {}

  /**
   * Records a search for history and trending queries (roadmap 5.3). Inserts
   * are rate-limited per shop and minute (`SEARCH_HISTORY_MAX_PER_MINUTE`,
   * counted in Redis so every instance shares the budget; per process when
   * Redis is down): a client hammering `/search` cannot grow SearchHistory
   * without bound. Returns whether the row was written.
   */
  async logSearch(shopId: string, userId: string | null, query: string, resultCount: number, durationMs: number): Promise<boolean> {
    if (!(await this.withinBudget(shopId))) return false;

    await this.prisma.searchHistory.create({
      data: {
        shopId,
        userId,
        query: clampSearchQuery(query),
        resultCount,
        durationMs,
      },
    });
    return true;
  }

  /** True while the shop has not used up this minute's history budget. */
  private async withinBudget(shopId: string): Promise<boolean> {
    const limit = this.searchFeatureConfig.historyMaxPerMinute;
    const bucket = Math.floor(Date.now() / WINDOW_MS);
    if (this.redis) {
      try {
        const key = `search-history:${shopId}:${bucket}`;
        // One round trip, and the TTL is set in the same MULTI as the first INCR (PEXPIRE NX: only when the key has none).
        const replies = await this.redis.multi().incr(key).pexpire(key, WINDOW_MS * 2, 'NX').exec();
        const hits = Number(replies?.[0]?.[1] ?? Number.NaN);
        if (!Number.isFinite(hits)) throw new Error('unexpected INCR reply');
        if (this.degraded) {
          this.degraded = false;
          this.logger.log('Redis search-history counters are back in use');
        }
        return hits <= limit;
      } catch (error) {
        if (!this.degraded) {
          this.degraded = true;
          this.logger.warn(`Redis unavailable for search-history counting, counting per process until it returns: ${(error as Error).message}`);
        }
      }
    }
    const entry = this.localWindow.get(shopId);
    if (!entry || entry.bucket !== bucket) {
      this.localWindow.set(shopId, { bucket, hits: 1 });
      if (this.localWindow.size > 10_000) this.localWindow.clear(); // bounded even under many tenants
      return 1 <= limit;
    }
    entry.hits += 1;
    return entry.hits <= limit;
  }

  /**
   * Retrieves popular trending searches.
   */
  async getPopularSearches(shopId: string) {
    // Basic aggregation: most frequent queries in the last 7 days
    const popular = await this.prisma.searchHistory.groupBy({
      by: ['query'],
      where: {
        shopId,
        createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
      },
      _count: { query: true },
      orderBy: { _count: { query: 'desc' } },
      take: this.searchFeatureConfig.analyticsLimit,
    });

    return popular.map(p => ({
      query: p.query,
      count: p._count.query
    }));
  }
}
