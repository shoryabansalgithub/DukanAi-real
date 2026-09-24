import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SynonymEngineService {
  private readonly logger = new Logger(SynonymEngineService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Expands a search query by applying registered synonyms.
   * e.g. "Soap" -> "Soap Detergent Cleaning Bar"
   */
  async expandQuery(shopId: string, query: string): Promise<string> {
    const tokens = query.toLowerCase().split(' ');
    const expanded = new Set<string>(tokens);

    for (const token of tokens) {
      const syn = await this.prisma.searchSynonym.findUnique({
        where: { shopId_term: { shopId, term: token } }
      });

      if (syn && syn.isActive) {
        const synonyms = syn.synonyms.split(',').map(s => s.trim().toLowerCase());
        synonyms.forEach(s => expanded.add(s));
      }
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
