import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MAX_EXPANDED_TERMS, queryTokens, tokenizeForSynonyms } from './search-term';

@Injectable()
export class SynonymEngineService {
  private readonly logger = new Logger(SynonymEngineService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Expands a search query with the shop's registered synonyms (roadmap 5.3,
   * audit P2-14). The query is tokenised once (lower case, de-duplicated,
   * capped at `MAX_SYNONYM_TOKENS`), every token is looked up in ONE
   * `findMany({ term: { in } })`, and the expansion is capped at
   * `MAX_EXPANDED_TERMS` terms so a synonym list can never blow up the
   * `contains` query built from it.
   * e.g. "Soap" -> "soap detergent cleaning bar"
   */
  async expandQuery(shopId: string, query: string): Promise<string> {
    const tokens = tokenizeForSynonyms(query);
    if (tokens.length === 0) return query;

    const rows = await this.prisma.searchSynonym.findMany({
      where: { shopId, isActive: true, term: { in: tokens } },
      select: { term: true, synonyms: true },
    });

    // Every typed token stays in the expansion (only the lookup is capped); synonyms fill the rest.
    const expanded = new Set<string>(queryTokens(query).slice(0, MAX_EXPANDED_TERMS));
    for (const row of rows) {
      for (const synonym of row.synonyms.split(',')) {
        if (expanded.size >= MAX_EXPANDED_TERMS) break;
        const term = synonym.trim().toLowerCase();
        if (term) expanded.add(term);
      }
      if (expanded.size >= MAX_EXPANDED_TERMS) break;
    }

    return Array.from(expanded).join(' ');
  }

  /**
   * Admin: Add a new synonym mapping.
   */
  async addSynonym(shopId: string, term: string, synonyms: string) {
    return this.prisma.searchSynonym.upsert({
      where: { shopId_term: { shopId, term: term.toLowerCase() } },
      update: { synonyms },
      create: { shopId, term: term.toLowerCase(), synonyms }
    });
  }
}
