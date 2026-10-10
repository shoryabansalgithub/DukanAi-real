import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';

@Injectable()
export class AnalyticsRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache
  ) {}

  // Low-level snapshot insertion utilized heavily by the Background Jobs
  
  async upsertDashboardSnapshot(shopId: string, date: Date, data: any) {
    // Normalize date to midnight UTC for unique grouping
    const normalizedDate = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    
    return this.prisma.purchaseAnalyticsSnapshot.upsert({
      where: {
        shopId_date: { shopId, date: normalizedDate }
      },
      update: {
        totalPurchases: data.totalPurchases,
        totalOrdersCount: data.totalOrdersCount,
        pendingOrdersCount: data.pendingOrdersCount,
        pendingGrnsCount: data.pendingGrnsCount,
        pendingBillsCount: data.pendingBillsCount,
        outstandingPayables: data.outstandingPayables,
        averageLeadTimeDays: data.averageLeadTimeDays,
        averageApprovalHours: data.averageApprovalHours
      },
      create: {
        shopId,
        date: normalizedDate,
        ...data
      }
    });
  }

  async upsertVendorPerformanceSnapshot(shopId: string, supplierId: string, data: any) {
    return this.prisma.vendorPerformanceSnapshot.upsert({
      where: {
        shopId_supplierId: { shopId, supplierId }
      },
      update: {
        purchaseVolume: data.purchaseVolume,
        orderCount: data.orderCount,
        onTimeDeliveryPct: data.onTimeDeliveryPct,
        averageLeadTimeDays: data.averageLeadTimeDays,
        defectRatePct: data.defectRatePct,
        returnRatePct: data.returnRatePct,
        overallScore: data.overallScore,
        lastCalculatedAt: new Date()
      },
      create: {
        shopId,
        supplierId,
        ...data
      }
    });
  }

  async upsertCategorySpendSnapshot(shopId: string, categoryId: string, data: any, departmentId: string | null = null) {
    // The unique key is (shopId, categoryId, departmentKey): departmentKey
    // mirrors departmentId with '-' for "no department", because MySQL never
    // compares NULLs in a unique index (phase 8 exit gate). Both are written.
    const departmentKey = departmentId ?? '-';
    return this.prisma.purchaseCategorySpendSnapshot.upsert({
      where: {
        shopId_categoryId_departmentKey: { shopId, categoryId, departmentKey },
      },
      update: {
        totalSpend: data.totalSpend,
        growthPct: data.growthPct,
      },
      create: {
        shopId,
        categoryId,
        departmentId,
        departmentKey,
        ...data,
      },
    });
  }

  async upsertTrendSnapshot(shopId: string, periodType: string, periodStart: Date, data: any) {
    return this.prisma.purchaseTrendSnapshot.upsert({
      where: {
        shopId_periodType_periodStart: { shopId, periodType, periodStart }
      },
      update: {
        spendAmount: data.spendAmount,
        orderCount: data.orderCount
      },
      create: {
        shopId,
        periodType,
        periodStart,
        ...data
      }
    });
  }
}
