import { Injectable, Logger } from '@nestjs/common';
import { AbcClass, Prisma, RecommendationType, XyzClass } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { businessDateString } from '../../common/time/business-day';
import { chunk } from '../engines/batch-write';
import { kpiDateFor } from './kpi.service';
import { ShopTimezoneService } from './shop-timezone.service';

/** A stockout risk score above this (days of inventory under 3) asks for a reorder. */
export const REORDER_RISK_THRESHOLD = 80;
/** Days of inventory beyond this is dead stock. */
export const LIQUIDATE_DAYS_THRESHOLD = 180;
/** A reorder covers this many days of the measured demand. */
export const REORDER_COVER_DAYS = 14;
export const LIQUIDATE_SCORE = 95;
export const LIQUIDATE_DISCOUNT_PERCENT = 20;
/** Recommendations older than this many business days are pruned each night. */
export const RECOMMENDATION_RETENTION_DAYS = 90;
/** KPI snapshots older than this many days are pruned each night (13 months of daily history). */
export const KPI_RETENTION_DAYS = 400;
const PRUNE_BATCH = 5000;
const DAY_MS = 24 * 3600 * 1000;

export interface RecommendationRow {
  productId: string;
  type: RecommendationType;
  score: number;
  reason: string;
  actionData: Record<string, unknown>;
}

export interface RecommendationRun {
  forDate: string;
  written: number;
  prunedRecommendations: number;
  prunedKpis: number;
}

/** Pure rule set: KPI snapshot + classification -> zero, one or two recommendations for a product. */
export function recommendationsFor(
  kpi: { productId: string; stockoutRiskScore: Prisma.Decimal; daysOfInventory: Prisma.Decimal; avgDailyUnits: Prisma.Decimal },
  classification: { abcClass: AbcClass; xyzClass: XyzClass } | undefined,
): RecommendationRow[] {
  const rows: RecommendationRow[] = [];
  const abcClass = classification?.abcClass ?? AbcClass.UNCLASSIFIED;
  const xyzClass = classification?.xyzClass ?? XyzClass.UNCLASSIFIED;
  const classes = { abcClass, xyzClass };

  if (kpi.stockoutRiskScore.greaterThan(REORDER_RISK_THRESHOLD)) {
    const suggestedQuantity = Math.max(1, kpi.avgDailyUnits.mul(REORDER_COVER_DAYS).ceil().toNumber());
    rows.push({
      productId: kpi.productId,
      type: RecommendationType.REORDER,
      score: kpi.stockoutRiskScore.toNumber(),
      reason: `Stock covers ${kpi.daysOfInventory.toFixed(1)} day(s) of demand (${abcClass}/${xyzClass} item).`,
      actionData: { suggestedQuantity, coverDays: REORDER_COVER_DAYS, avgDailyUnits: kpi.avgDailyUnits.toNumber(), ...classes },
    });
  }

  if (kpi.daysOfInventory.greaterThan(LIQUIDATE_DAYS_THRESHOLD)) {
    rows.push({
      productId: kpi.productId,
      type: RecommendationType.LIQUIDATE,
      score: LIQUIDATE_SCORE,
      reason: `Dead stock risk: ${kpi.daysOfInventory.toFixed(0)} days of inventory on hand (${abcClass}/${xyzClass} item).`,
      actionData: { suggestedDiscount: LIQUIDATE_DISCOUNT_PERCENT, daysOfInventory: kpi.daysOfInventory.toNumber(), ...classes },
    });
  }

  return rows;
}

/**
 * Nightly recommendations (roadmap 4.9). Reads the KPI snapshot KpiService
 * wrote for the same business day plus the ABC/XYZ classes, derives the
 * recommendations, and upserts them on `(shopId, productId, forDate, type)`
 * in multi-row batches: a re-run of the night refreshes score, reason and
 * action data and keeps the `status` a user set (DISMISSED / ACTIONED). Rows
 * older than the retention window are pruned in bounded batches so the table
 * never grows without limit.
 */
@Injectable()
export class RecommendationEngineService {
  private readonly logger = new Logger(RecommendationEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shopTimezone: ShopTimezoneService,
  ) {}

  async generateRecommendations(shopId: string, now: Date = new Date()): Promise<RecommendationRun> {
    const timeZone = await this.shopTimezone.resolve(shopId);
    const date = kpiDateFor(now, timeZone);
    const forDate = businessDateString(now, timeZone);

    const [kpis, classifications] = await Promise.all([
      this.prisma.inventoryKpi.findMany({
        where: { shopId, date },
        select: { productId: true, stockoutRiskScore: true, daysOfInventory: true, avgDailyUnits: true },
      }),
      this.prisma.inventoryClassification.findMany({ where: { shopId }, select: { productId: true, abcClass: true, xyzClass: true } }),
    ]);
    const classByProduct = new Map(classifications.map((c) => [c.productId, c]));

    const rows = kpis.flatMap((kpi) => recommendationsFor(kpi, classByProduct.get(kpi.productId)));
    for (const batch of chunk(rows)) {
      const values = batch.map(
        (r) => Prisma.sql`(${randomUUID()}, ${shopId}, ${r.productId}, ${forDate}, ${r.type}, ${r.score}, ${r.reason}, ${JSON.stringify(r.actionData)}, 'ACTIVE', ${now}, ${now})`,
      );
      await this.prisma.$executeRaw`
        INSERT INTO InventoryRecommendation (id, shopId, productId, forDate, type, score, reason, actionData, status, createdAt, updatedAt)
        VALUES ${Prisma.join(values)}
        ON DUPLICATE KEY UPDATE score = VALUES(score), reason = VALUES(reason), actionData = VALUES(actionData), updatedAt = VALUES(updatedAt)
      `;
    }

    const prunedRecommendations = await this.pruneInBatches(
      (limit) => this.prisma.$executeRaw`
        DELETE FROM InventoryRecommendation
        WHERE shopId = ${shopId} AND forDate < ${businessDateString(new Date(now.getTime() - RECOMMENDATION_RETENTION_DAYS * DAY_MS), timeZone)}
        LIMIT ${limit}
      `,
    );
    const prunedKpis = await this.pruneInBatches(
      (limit) => this.prisma.$executeRaw`
        DELETE FROM InventoryKpi
        WHERE shopId = ${shopId} AND date < ${businessDateString(new Date(now.getTime() - KPI_RETENTION_DAYS * DAY_MS), timeZone)}
        LIMIT ${limit}
      `,
    );

    this.logger.log(`Shop ${shopId}: ${rows.length} recommendation(s) for ${forDate}, pruned ${prunedRecommendations} recommendation(s) and ${prunedKpis} KPI row(s)`);
    return { forDate, written: rows.length, prunedRecommendations, prunedKpis };
  }

  /** Deletes in LIMIT-bounded statements so a long-lived shop never holds one giant delete lock. */
  private async pruneInBatches(deleteBatch: (limit: number) => Promise<number>): Promise<number> {
    let total = 0;
    for (;;) {
      const deleted = await deleteBatch(PRUNE_BATCH);
      total += deleted;
      if (deleted < PRUNE_BATCH) return total;
    }
  }
}
