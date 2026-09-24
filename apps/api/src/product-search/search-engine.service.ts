import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import * as fuzzysort from 'fuzzysort';
import { GstRate, Prisma, ProductType, ProductUnit } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SearchFeatureConfig } from '../config/domains/features/search-feature.config';
import { CacheConfig } from '../config/domains/cache.config';
import { normalizeSearchQuery, sanitizeFulltextTerm } from './search-term';

/** Lean POS product shape (contract §5). Money and quantities are plain numbers. */
export interface LeanProduct {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  sellingPrice: number;
  mrp: number;
  gstRate: GstRate;
  /** Cess percentage on the taxable amount (0 for most products). */
  cessRate: number;
  unit: ProductUnit;
  currentStock: number;
  type: ProductType;
  isActive: boolean;
  imageUrl: string | null;
  categoryName: string | null;
  /** Present when the match came from a variant barcode. */
  variantId?: string;
}

/** Name-prefix suggestion row from `GET /search/suggestions`. */
export interface SuggestionRow {
  id: string;
  name: string;
  cessRate: number;
}

export interface SearchOptions {
  /** Synonym-expanded query used for fulltext/contains; defaults to the raw query. */
  expandedQuery?: string;
  sort?: string;
  limit?: number;
}

const LEAN_PRODUCT_SELECT = {
  id: true,
  name: true,
  sku: true,
  barcode: true,
  sellingPrice: true,
  mrp: true,
  gstRate: true,
  cessRate: true,
  unit: true,
  currentStock: true,
  type: true,
  isActive: true,
  imageUrl: true,
  category: { select: { name: true } },
} satisfies Prisma.ProductSelect;

type LeanProductRow = Prisma.ProductGetPayload<{ select: typeof LEAN_PRODUCT_SELECT }>;

const CANDIDATE_SELECT = {
  id: true,
  name: true,
  sku: true,
  barcode: true,
  aliases: true,
  category: { select: { name: true } },
  brand: { select: { name: true } },
  variants: { where: { isDeleted: false, isActive: true }, select: { sku: true, barcode: true } },
  barcodes: { where: { isActive: true }, select: { barcode: true } },
} satisfies Prisma.ProductSelect;

type CandidateRow = Prisma.ProductGetPayload<{ select: typeof CANDIDATE_SELECT }>;

/** Score assigned to an exact barcode / SKU hit so it always outranks fuzzy hits. */
export const EXACT_MATCH_SCORE = 1000;
const MAX_SEARCH_LIMIT = 100;
const DEFAULT_SEARCH_LIMIT = 20;

export function toLeanProduct(row: LeanProductRow, variantId?: string): LeanProduct {
  const lean: LeanProduct = {
    id: row.id,
    name: row.name,
    sku: row.sku,
    barcode: row.barcode,
    sellingPrice: row.sellingPrice.toNumber(),
    mrp: row.mrp.toNumber(),
    gstRate: row.gstRate,
    cessRate: row.cessRate.toNumber(),
    unit: row.unit,
    currentStock: row.currentStock.toNumber(),
    type: row.type,
    isActive: row.isActive,
    imageUrl: row.imageUrl,
    categoryName: row.category?.name ?? null,
  };
  if (variantId) lean.variantId = variantId;
  return lean;
}

@Injectable()
export class SearchEngineService {
  private readonly logger = new Logger(SearchEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly searchFeatureConfig: SearchFeatureConfig,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly cacheConfig: CacheConfig,
  ) {}

  /**
   * POS product search. Exact barcode / SKU hits (never cached) come first,
   * then fuzzy name/alias/category/brand hits. Only the ranked id list of the
   * fuzzy part is cached (short TTL) because `currentStock` changes on every
   * sale; product rows are always re-read fresh before returning.
   */
  async search(shopId: string, rawQuery: string, options: SearchOptions = {}): Promise<LeanProduct[]> {
    const query = normalizeSearchQuery(rawQuery);
    if (!query) return [];
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
    const expanded = normalizeSearchQuery(options.expandedQuery) || query;

    const [exactIds, fuzzyIds] = await Promise.all([
      this.exactCodeMatches(shopId, query),
      this.rankedFuzzyIds(shopId, query, expanded, options.sort),
    ]);

    const exactSet = new Set(exactIds);
    const orderedIds = [...exactIds, ...fuzzyIds.filter((id) => !exactSet.has(id))].slice(0, limit);
    if (orderedIds.length === 0) return [];

    const rows = await this.prisma.product.findMany({
      where: { id: { in: orderedIds }, shopId, isDeleted: false, isActive: true },
      select: LEAN_PRODUCT_SELECT,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const results: LeanProduct[] = [];
    for (const id of orderedIds) {
      const row = byId.get(id);
      if (row) results.push(toLeanProduct(row));
    }
    return this.applySort(results, options.sort);
  }

  /**
   * Exact match across Product.barcode, ProductBarcode.barcode and
   * ProductVariant.barcode. Returns the parent product (plus `variantId` for a
   * variant hit). 404 `BARCODE_NOT_FOUND`, 409 `BARCODE_AMBIGUOUS`.
   */
  async findByBarcode(shopId: string, rawCode: string): Promise<LeanProduct> {
    const code = normalizeSearchQuery(rawCode);
    if (!code) {
      throw new NotFoundException({ message: 'Barcode not found', code: 'BARCODE_NOT_FOUND' });
    }

    const [products, variants] = await Promise.all([
      this.prisma.product.findMany({
        where: {
          shopId,
          isDeleted: false,
          isActive: true,
          OR: [{ barcode: code }, { barcodes: { some: { shopId, barcode: code, isActive: true } } }],
        },
        select: LEAN_PRODUCT_SELECT,
      }),
      // ProductVariant is not tenant-scoped by the Prisma extension: filter shopId explicitly.
      this.prisma.productVariant.findMany({
        where: {
          shopId,
          barcode: code,
          isDeleted: false,
          isActive: true,
          product: { isDeleted: false, isActive: true },
        },
        select: { id: true, productId: true, product: { select: LEAN_PRODUCT_SELECT } },
      }),
    ]);

    const candidates = new Map<string, LeanProduct>();
    for (const row of products) candidates.set(row.id, toLeanProduct(row));
    for (const variant of variants) {
      if (!candidates.has(variant.productId)) {
        candidates.set(variant.productId, toLeanProduct(variant.product, variant.id));
      }
    }

    if (candidates.size === 0) {
      throw new NotFoundException({ message: 'Barcode not found', code: 'BARCODE_NOT_FOUND' });
    }
    if (candidates.size > 1) {
      throw new ConflictException({
        message: 'Barcode is assigned to multiple products',
        code: 'BARCODE_AMBIGUOUS',
        details: {
          candidates: [...candidates.values()].map((p) => ({
            id: p.id,
            name: p.name,
            sku: p.sku,
            ...(p.variantId ? { variantId: p.variantId } : {}),
          })),
        },
      });
    }
    return [...candidates.values()][0];
  }

  /** Fast autocomplete on name prefix; active, non-deleted products only. */
  async autocomplete(shopId: string, rawQuery: string): Promise<SuggestionRow[]> {
    const query = normalizeSearchQuery(rawQuery);
    if (query.length < 2) return [];

    const cacheKey = `autocomplete:${shopId}:${query.toLowerCase()}`;
    const cached = await this.cacheGet<SuggestionRow[]>(cacheKey);
    if (cached) return cached;

    const rows = await this.prisma.product.findMany({
      where: { shopId, isDeleted: false, isActive: true, name: { startsWith: query } },
      select: { id: true, name: true, cessRate: true },
      orderBy: { name: 'asc' },
      take: this.searchFeatureConfig.searchResultLimit,
    });
    const products: SuggestionRow[] = rows.map((row) => ({ id: row.id, name: row.name, cessRate: row.cessRate.toNumber() }));

    await this.cacheSet(cacheKey, products, this.cacheConfig.searchStockTtlMs);
    return products;
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  /** Product ids with an exact barcode / SKU hit. Never cached. */
  private async exactCodeMatches(shopId: string, code: string): Promise<string[]> {
    const [products, variants] = await Promise.all([
      this.prisma.product.findMany({
        where: {
          shopId,
          isDeleted: false,
          isActive: true,
          OR: [
            { barcode: code },
            { sku: code },
            { barcodes: { some: { shopId, barcode: code, isActive: true } } },
          ],
        },
        select: { id: true },
        take: MAX_SEARCH_LIMIT,
      }),
      this.prisma.productVariant.findMany({
        where: {
          shopId,
          isDeleted: false,
          isActive: true,
          OR: [{ barcode: code }, { sku: code }],
          product: { isDeleted: false, isActive: true },
        },
        select: { productId: true },
        take: MAX_SEARCH_LIMIT,
      }),
    ]);
    const ids = new Set<string>();
    for (const p of products) ids.add(p.id);
    for (const v of variants) ids.add(v.productId);
    return [...ids];
  }

  /** Fuzzy-ranked product ids for the query; cached for a short TTL. */
  private async rankedFuzzyIds(
    shopId: string,
    query: string,
    expanded: string,
    sort: string | undefined,
  ): Promise<string[]> {
    const cacheKey = `search:${shopId}:ids:${sort ?? 'rel'}:${expanded.toLowerCase()}`;
    const cached = await this.cacheGet<string[]>(cacheKey);
    if (cached) return cached;

    const candidates = await this.fetchCandidates(shopId, query, expanded);
    const ranked = this.rankCandidates(query, candidates).map((c) => c.id);

    await this.cacheSet(cacheKey, ranked, this.cacheConfig.searchStockTtlMs);
    return ranked;
  }

  private async fetchCandidates(shopId: string, query: string, expanded: string): Promise<CandidateRow[]> {
    const fulltextTerm = sanitizeFulltextTerm(expanded);
    // MySQL `contains` is case-insensitive under the default collation, so the
    // synonym-expanded (lower-cased) query only adds a clause when it differs.
    const containsTerms = [query, expanded].filter(
      (term, index, all) => term.length > 0 && all.findIndex((t) => t.toLowerCase() === term.toLowerCase()) === index,
    );

    const or: Prisma.ProductWhereInput[] = [];
    if (fulltextTerm) {
      // All three columns of the @@fulltext([name, aliases, searchKeywords]) index
      // must be searched with the same term so MySQL can use the index.
      or.push(
        { name: { search: fulltextTerm } },
        { aliases: { search: fulltextTerm } },
        { searchKeywords: { search: fulltextTerm } },
      );
    }
    for (const term of containsTerms) {
      or.push(
        { name: { contains: term } },
        { sku: { contains: term } },
        { aliases: { contains: term } },
        { category: { name: { contains: term } } },
        { brand: { name: { contains: term } } },
        { variants: { some: { isDeleted: false, isActive: true, sku: { contains: term } } } },
      );
    }

    return this.prisma.product.findMany({
      where: { shopId, isDeleted: false, isActive: true, OR: or },
      select: CANDIDATE_SELECT,
      take: this.searchFeatureConfig.fuzzyCandidateLimit,
    });
  }

  /** Scores candidates with fuzzysort against the raw query; unmatched rows keep DB order at the tail. */
  private rankCandidates(query: string, candidates: CandidateRow[]): CandidateRow[] {
    const scored = candidates.map((candidate, index) => {
      const haystack = [
        candidate.name,
        candidate.sku,
        candidate.barcode ?? '',
        candidate.aliases ?? '',
        candidate.category?.name ?? '',
        candidate.brand?.name ?? '',
        ...candidate.variants.map((v) => `${v.sku} ${v.barcode ?? ''}`),
        ...candidate.barcodes.map((b) => b.barcode),
      ]
        .filter((part) => part.length > 0)
        .join(' ');
      const match = fuzzysort.single(query, haystack);
      return { candidate, index, score: match ? match.score : 0 };
    });
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    return scored.map((s) => s.candidate);
  }

  private applySort(results: LeanProduct[], sort: string | undefined): LeanProduct[] {
    if (sort === 'price_asc') return [...results].sort((a, b) => a.sellingPrice - b.sellingPrice);
    if (sort === 'price_desc') return [...results].sort((a, b) => b.sellingPrice - a.sellingPrice);
    return results;
  }

  private async cacheGet<T>(key: string): Promise<T | undefined> {
    try {
      return (await this.cacheManager.get<T>(key)) ?? undefined;
    } catch (error) {
      this.logger.warn(`Cache read failed for ${key}: ${(error as Error).message}`);
      return undefined;
    }
  }

  private async cacheSet(key: string, value: unknown, ttlMs: number): Promise<void> {
    try {
      await this.cacheManager.set(key, value, ttlMs);
    } catch (error) {
      this.logger.warn(`Cache write failed for ${key}: ${(error as Error).message}`);
    }
  }
}
