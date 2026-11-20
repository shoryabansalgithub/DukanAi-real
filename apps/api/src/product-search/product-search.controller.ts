import { BadRequestException, Body, Controller, Get, Logger, Param, Post, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { SearchEngineService } from './search-engine.service';
import { SynonymEngineService } from './synonym-engine.service';
import { SearchAnalyticsService } from './search-analytics.service';
import { IndexingEngineService } from './indexing-engine.service';
import { clampSearchQuery, parseLimit } from './search-term';
import { Roles } from '../auth/roles.decorator';
import { CurrentShop } from '../iam/decorators/current-shop.decorator';
import { CurrentUser } from '../iam/decorators/current-user.decorator';
import { SafeUserDto } from '../users/dto/safe-user.dto';
import { AddSynonymDto } from './dto/add-synonym.dto';

const READ_ROLES: Role[] = [Role.OWNER, Role.ADMIN, Role.SUPER_ADMIN, Role.MANAGER, Role.CASHIER, Role.VIEWER];
const MANAGE_ROLES: Role[] = [Role.OWNER, Role.ADMIN, Role.SUPER_ADMIN, Role.MANAGER];

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

@Controller('search')
export class ProductSearchController {
  private readonly logger = new Logger(ProductSearchController.name);

  constructor(
    private readonly searchEngine: SearchEngineService,
    private readonly synonymEngine: SynonymEngineService,
    private readonly searchAnalytics: SearchAnalyticsService,
    private readonly indexEngine: IndexingEngineService,
  ) {}

  /** `GET /search?q&limit&sort` — lean, relevance-ranked POS results (contract §5). */
  @Get()
  @Roles(...READ_ROLES)
  async search(
    @Query('q') rawQuery: string | undefined,
    @Query('sort') sort: string | undefined,
    @Query('limit') limitStr: string | undefined,
    @CurrentShop() shopId: string,
    @CurrentUser() user: SafeUserDto,
  ) {
    // Roadmap 5.3: the query is normalised and capped once; every consumer below sees the same value.
    const query = clampSearchQuery(rawQuery);
    if (!query) throw new BadRequestException('Query is required');
    const limit = parseLimit(limitStr, DEFAULT_LIMIT, MAX_LIMIT);
    const start = Date.now();

    let expandedQuery = query;
    try {
      expandedQuery = await this.synonymEngine.expandQuery(shopId, query);
    } catch (error) {
      this.logger.warn(`Synonym expansion failed: ${(error as Error).message}`);
    }

    const results = await this.searchEngine.search(shopId, query, { expandedQuery, sort, limit });

    // Analytics logging is best-effort and must never affect the response.
    void this.searchAnalytics
      .logSearch(shopId, user?.id ?? null, query, results.length, Date.now() - start)
      .catch((error: unknown) => this.logger.warn(`Search analytics logging failed: ${(error as Error).message}`));

    return results;
  }

  /** `GET /search/barcode/:code` — exactly one product or 404 / 409 (contract §5). */
  @Get('barcode/:code')
  @Roles(...READ_ROLES)
  async findByBarcode(@Param('code') code: string, @CurrentShop() shopId: string) {
    return this.searchEngine.findByBarcode(shopId, code);
  }

  @Get('suggestions')
  @Roles(...READ_ROLES)
  async getSuggestions(@Query('q') rawQuery: string | undefined, @CurrentShop() shopId: string) {
    const query = clampSearchQuery(rawQuery);
    if (!query) return [];
    return this.searchEngine.autocomplete(shopId, query);
  }

  @Get('popular')
  @Roles(...READ_ROLES)
  async getPopular(@CurrentShop() shopId: string) {
    return this.searchAnalytics.getPopularSearches(shopId);
  }

  @Post('synonyms')
  @Roles(...MANAGE_ROLES)
  async addSynonym(@Body() body: AddSynonymDto, @CurrentShop() shopId: string) {
    return this.synonymEngine.addSynonym(shopId, body.term, body.synonyms);
  }

  @Post('reindex')
  @Roles(...MANAGE_ROLES)
  async reindex(@CurrentShop() shopId: string) {
    await this.indexEngine.triggerFullReindex(shopId);
    return { message: 'Full reindex triggered successfully' };
  }
}
