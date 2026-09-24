import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RecommendationType } from '@prisma/client';
import { kpiDateFor } from './kpi.service';
import { ShopTimezoneService } from './shop-timezone.service';

@Injectable()
export class RecommendationEngineService {
  private readonly logger = new Logger(RecommendationEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shopTimezone: ShopTimezoneService,
  ) {}

  /**
   * Analyzes current KPIs and classifications to generate actionable business advice.
   * Reads the KPI snapshot written for the same shop business date by KpiService.
   */
  async generateRecommendations(shopId: string, now: Date = new Date()) {
    this.logger.log(`Generating Inventory Recommendations for shop ${shopId}...`);

    const timeZone = await this.shopTimezone.resolve(shopId);
    const date = kpiDateFor(now, timeZone);

    const kpis = await this.prisma.inventoryKpi.findMany({
      where: { shopId, date }
    });

    for (const kpi of kpis) {
      // Rule 1: High Stockout Risk -> REORDER
      if (kpi.stockoutRiskScore.toNumber() > 80) {
        await this.prisma.inventoryRecommendation.create({
          data: {
            shopId,
            productId: kpi.productId,
            type: RecommendationType.REORDER,
            score: kpi.stockoutRiskScore,
            reason: 'High stockout risk based on current holding and demand velocity.',
            actionData: { suggestedQuantity: 100 }
          }
        });
      }

      // Rule 2: High Days of Inventory -> LIQUIDATE (Dead Stock Risk)
      if (kpi.daysOfInventory.toNumber() > 180) {
        await this.prisma.inventoryRecommendation.create({
          data: {
            shopId,
            productId: kpi.productId,
            type: RecommendationType.LIQUIDATE,
            score: 95,
            reason: 'Dead stock risk. Inventory aging beyond 180 days.',
            actionData: { suggestedDiscount: 20 }
          }
        });
      }
    }

    this.logger.log(`Generated recommendations.`);
  }
}
