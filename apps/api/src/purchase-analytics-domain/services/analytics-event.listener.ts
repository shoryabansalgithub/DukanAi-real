import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { Clock } from '../../common/time/clock';
import { purchaseBusinessDates } from '../analytics-dates';
import { dashboardCacheKey } from './analytics-dashboard.service';

@Injectable()
export class AnalyticsEventListener implements OnModuleInit {
  private readonly logger = new Logger(AnalyticsEventListener.name);

  constructor(
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    @InjectQueue('purchase-analytics') private readonly analyticsQueue: Queue,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  onModuleInit() {
    this.logger.log('Initializing Analytics Event Listeners...');
  }
  
  @OnEvent('PurchaseOrderApproved')
  async handlePurchaseOrderApproved(event: any) {
    await this.handleDocumentUpdate(event.shopId);
  }

  @OnEvent('GRNCompleted')
  async handleGRNCompleted(event: any) {
    await this.handleDocumentUpdate(event.shopId);
  }

  @OnEvent('VendorBillPosted')
  async handleVendorBillPosted(event: any) {
    await this.handleDocumentUpdate(event.shopId);
  }
  
  private async handleDocumentUpdate(shopId: string) {
    // Today in the shop's time zone, the key the dashboard reads (release audit #26).
    const { dateKey } = await purchaseBusinessDates(this.prisma, shopId, this.clock.now());
    const cacheKey = dashboardCacheKey(shopId, dateKey);
    
    // 1. Invalidate instantly so users get fresh fallback data
    await this.cacheManager.del(cacheKey);
    
    // 2. Queue heavy rebuilding operation in the background
    await this.analyticsQueue.add('aggregate-daily-dashboard', { shopId });
    await this.analyticsQueue.add('aggregate-vendor-performance', { shopId });
    await this.analyticsQueue.add('aggregate-category-spend', { shopId });
    await this.analyticsQueue.add('aggregate-trends', { shopId });
  }
}
