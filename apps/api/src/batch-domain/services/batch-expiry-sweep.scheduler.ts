import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { CronLockService } from '../../common/cron-lock/cron-lock.service';
import { sweepEveryShop, SweepSummary } from '../../common/sweeps/per-shop-sweep';
import { CronConfig } from '../../config/domains/cron.config';
import { TenantContextService } from '../../iam/tenant-context/tenant-context.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ExpiryService } from './expiry.service';

export const BATCH_EXPIRY_SWEEP_JOB = 'BatchExpirySweep';
const LOCK_TTL_MS = 5 * 60_000;

/**
 * Global batch-expiry sweep: one pod at a time (cron lock), every shop in its
 * own tenant context. `POST /batches/sweep-expiry` stays available for a
 * shop to sweep itself on demand.
 */
@Injectable()
export class BatchExpirySweepScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(BatchExpirySweepScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly expiryService: ExpiryService,
    private readonly cronLock: CronLockService,
    private readonly cronConfig: CronConfig,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly tenantContext: TenantContextService,
  ) {}

  onApplicationBootstrap() {
    if (!this.cronConfig.enabled) {
      this.logger.warn(`${BATCH_EXPIRY_SWEEP_JOB} schedule not registered: CRON_ENABLED=false`);
      return;
    }
    const job = new CronJob(this.cronConfig.batchExpirySweepCron, () => {
      this.handleCron().catch((error: unknown) => this.logger.error(`${BATCH_EXPIRY_SWEEP_JOB} crashed: ${(error as Error).message}`));
    });
    this.schedulerRegistry.addCronJob(BATCH_EXPIRY_SWEEP_JOB, job);
    job.start();
  }

  handleCron(): Promise<SweepSummary | null> {
    return this.cronLock.withLock('cron:batch-expiry-sweep', LOCK_TTL_MS, () => this.sweepAllShops());
  }

  sweepAllShops(): Promise<SweepSummary> {
    return sweepEveryShop(this.prisma, this.tenantContext, this.logger, BATCH_EXPIRY_SWEEP_JOB, (shopId) => this.expiryService.quarantineExpiredBatches(shopId));
  }
}
