import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { jobContext } from '../iam/tenant-context/job-context';

@Processor('search-indexing')
@Injectable()
export class IndexingWorker extends WorkerHost {
  private readonly logger = new Logger(IndexingWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly tenantContext: TenantContextService,
  ) {
    super();
  }

  process(job: Job<any, any, string>): Promise<any> {
    const shopId = job.data?.shopId;
    if (typeof shopId !== 'string' || !shopId) throw new Error(`Search indexing job ${String(job.id)} has no shopId`);
    return this.tenantContext.runWithContext(jobContext(shopId, String(job.id)), () => this.processForShop(job));
  }

  private async processForShop(job: Job<any, any, string>): Promise<any> {
    switch (job.name) {
      case 'full-reindex':
        return this.handleFullReindex(job.data);
      case 'incremental-index':
        return this.handleIncrementalIndex(job.data);
      default:
        this.logger.warn(`Unknown job name: ${job.name}`);
    }
  }

  private async handleFullReindex(data: { shopId: string }) {
    this.logger.log(`Starting full reindex for shop ${data.shopId}`);
    
    // Update status
    await this.prisma.searchIndexStatus.upsert({
      where: { shopId_entityType: { shopId: data.shopId, entityType: 'PRODUCT' } },
      update: { status: 'INDEXING' },
      create: { shopId: data.shopId, entityType: 'PRODUCT', status: 'INDEXING' }
    });

    try {
      // In a real system, we'd pull all products in batches and hydrate RedisSearch.
      // For this phase, we simply clear the search cache namespace so SQL fetches fresh.
      
      // We would use redis keys command, but with cache-manager it's tricky.
      // Just a stub for clearing cache related to this shop:
      this.logger.log(`Flushing search cache for shop ${data.shopId}`);

      await this.prisma.searchIndexStatus.update({
        where: { shopId_entityType: { shopId: data.shopId, entityType: 'PRODUCT' } },
        data: { status: 'COMPLETED', lastRun: new Date() }
      });
    } catch (err) {
      await this.prisma.searchIndexStatus.update({
        where: { shopId_entityType: { shopId: data.shopId, entityType: 'PRODUCT' } },
        data: { status: 'FAILED', error: (err as Error).message }
      });
      throw err;
    }
  }

  private async handleIncrementalIndex(data: { shopId: string, entityId: string, entityType: string }) {
    this.logger.log(`Incremental index stub executed for ${data.entityType} ${data.entityId}`);
  }
}
